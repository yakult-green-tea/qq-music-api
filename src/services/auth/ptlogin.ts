import { WEB_ANONYMOUS_COMM } from '../../protocol/clientProfiles';
import { credentialExpiryAt } from './credentialExpiry';
import type { QqCredential } from './qrTypes';

// src/services/auth/ptlogin.ts
// 手机 QQ 扫码的纯 HTTP 做法，走 QQ 互联的网页登录（官方网页「QQ 登录」用的同一套）：
// ptqrshow 出码 → ptqrlogin 查状态 → check_sig → login_jump → authorize → QQLogin 换凭证。
// 给没有 MQTT relay 的 Serverless 用，不建长连接，每一步都是一次普通的 HTTP 请求。
//
// 每一步都照白名单走：
// - 不自动跟随转址，转到哪里自己检查主机和路径；
// - Cookie 只认指定网域，QQ 全局 Cookie（p_skey 等）只送到 graph.qq.com，换到 code 就丢掉；
// - 上游的 JSONP 只按字符串解析，不执行；
// - 回包限大小，图片要真的是 PNG。
// 这些都只在 Serverless 用；runtime 中立，不 import axios、ws、node:*。

export type PtloginFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface PtloginOptions {
  fetch?: PtloginFetch;
  signal?: AbortSignal;
}

export interface PtloginQr {
  qrsig: string;
  imageUrl: string;
  expiresIn: number;
}

export type PtloginPoll =
  | { status: 'waiting' }
  | { status: 'scanned' }
  | { status: 'expired' }
  | { status: 'confirmed'; checkSigUrl: string };

export type PtloginStep =
  | 'qr-show'
  | 'qr-poll'
  | 'check-sig'
  | 'login-jump'
  | 'authorize'
  | 'qq-login';

export class PtloginError extends Error {
  constructor(
    message: string,
    readonly step: PtloginStep,
    readonly details: { httpStatus?: number; upstreamCode?: number; globalCode?: number } = {},
  ) {
    super(message);
    this.name = 'PtloginError';
  }

  get httpStatus(): number | undefined {
    return this.details.httpStatus;
  }

  get upstreamCode(): number | undefined {
    return this.details.upstreamCode;
  }

  get globalCode(): number | undefined {
    return this.details.globalCode;
  }
}

/** 上游的二维码大约 120 秒失效（官网实测 120 秒最后一次 66、123 秒第一次 65）。 */
export const PTLOGIN_QR_TTL_SECONDS = 120;

const PTLOGIN_HOST = 'https://xui.ptlogin2.qq.com';
const LOGIN_JUMP = 'https://graph.qq.com/oauth2.0/login_jump';
const AUTHORIZE = 'https://graph.qq.com/oauth2.0/authorize';
const REDIRECT = 'https://y.qq.com/portal/wx_redirect.html';
const MUSICU = 'https://u.y.qq.com/cgi-bin/musicu.fcg';
// QQ 音乐网页在 QQ 互联的应用身份（公开值，官网页面里就有）。
const PTLOGIN_APP_ID = '716027609';
const CONNECT_CLIENT_ID = '100497308';
const SCOPE = 'get_user_info,get_app_friends';
const GRAPH_COOKIES = ['p_uin', 'p_skey', 'pt_oauth_token'] as const;
const COOKIE_VALUE = /^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]{1,512}$/;
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const MAX_TEXT_BYTES = 16_384;
const MAX_IMAGE_BYTES = 4096;
// 调用方没给 signal 时，每一步自己的上限。
const STEP_TIMEOUT_MS = 10_000;

/** QQ 登录页用的 hash33：ptqrtoken 的初值是 0，g_tk 的初值是 5381。 */
const hash33 = (value: string, initial: number): number => {
  let result = initial;
  for (const character of value) result += (result << 5) + character.charCodeAt(0);
  return result & 0x7fffffff;
};

const fail = (step: PtloginStep, message: string, details?: PtloginError['details']) =>
  new PtloginError(message, step, details);

const send = async (
  step: PtloginStep,
  url: string,
  init: RequestInit,
  options: PtloginOptions,
): Promise<Response> => {
  const fetcher = options.fetch ?? ((input, request) => globalThis.fetch(input, request));
  const response = await fetcher(url, {
    ...init,
    // Vercel Edge、Cloudflare Workers 不收 'error'；转址一律自己判断。
    redirect: 'manual',
    signal: options.signal ?? AbortSignal.timeout(STEP_TIMEOUT_MS),
  });
  if (response.status < 200 || response.status >= 400) {
    void response.body?.cancel().catch(() => undefined);
    throw fail(step, 'Ptlogin upstream HTTP error', { httpStatus: response.status });
  }
  return response;
};

const textOf = async (step: PtloginStep, response: Response): Promise<string> => {
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > MAX_TEXT_BYTES) throw fail(step, 'Ptlogin response too large');
  return new TextDecoder().decode(bytes);
};

/** 只取指定网域上的 Cookie；同名的清除项会把之前的值清掉。 */
const cookieOf = (response: Response, name: string, domain: string): string | undefined => {
  const separate = response.headers.getSetCookie?.() ?? [];
  const entries = separate.length
    ? separate
    : (response.headers.get('set-cookie') ?? '').split(/,(?=\s*[^;,=\s]+=)/);
  let found: string | undefined;
  for (const entry of entries) {
    const parts = entry.split(';').map((part) => part.trim());
    const separator = parts[0].indexOf('=');
    if (separator <= 0 || parts[0].slice(0, separator) !== name) continue;
    const attributes = parts.slice(1);
    const declared = attributes
      .find((part) => /^domain=/i.test(part))
      ?.slice(7)
      .toLowerCase()
      .replace(/^\./, '');
    if (declared !== domain) continue;
    const value = parts[0].slice(separator + 1);
    found =
      attributes.some((part) => /^max-age=0$/i.test(part)) || !COOKIE_VALUE.test(value)
        ? undefined
        : value;
  }
  return found;
};

/** 只接受 https、指定主机与路径的网址，不带账号密码、端口或片段。 */
const trustedUrl = (step: PtloginStep, raw: string, host: string, pathname: string): URL => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw fail(step, 'Ptlogin redirect is not allowed');
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== host ||
    url.port ||
    url.username ||
    url.password ||
    url.pathname !== pathname ||
    url.hash
  )
    throw fail(step, 'Ptlogin redirect is not allowed');
  return url;
};

const imageOf = async (response: Response): Promise<string> => {
  const bytes = new Uint8Array(await response.arrayBuffer());
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const valid =
    bytes.length >= 32 &&
    bytes.length <= MAX_IMAGE_BYTES &&
    PNG_SIGNATURE.every((value, index) => bytes[index] === value) &&
    view.getUint32(8) === 13 &&
    view.getUint32(12) === 0x49484452 &&
    view.getUint32(16) >= 1 &&
    view.getUint32(16) <= 2048 &&
    view.getUint32(20) >= 1 &&
    view.getUint32(20) <= 2048;
  if (!valid) throw fail('qr-show', 'Ptlogin QR image is not a PNG');
  let binary = '';
  for (const value of bytes) binary += String.fromCharCode(value);
  return `data:image/png;base64,${btoa(binary)}`;
};

/** 出一张新的二维码。`qrsig` 是之后查状态的凭据，要原样保存。 */
export const createPtloginQr = async (options: PtloginOptions = {}): Promise<PtloginQr> => {
  const url = new URL(`${PTLOGIN_HOST}/ssl/ptqrshow`);
  url.search = new URLSearchParams({
    appid: PTLOGIN_APP_ID,
    e: '2',
    l: 'M',
    s: '3',
    d: '72',
    v: '4',
    t: String(Math.random()),
    daid: '383',
    pt_3rd_aid: CONNECT_CLIENT_ID,
    u1: LOGIN_JUMP,
  }).toString();
  const response = await send('qr-show', url.toString(), { method: 'GET' }, options);
  if (response.status !== 200) throw fail('qr-show', 'Ptlogin QR image is not a PNG');
  const qrsig = cookieOf(response, 'qrsig', 'ptlogin2.qq.com');
  if (!qrsig) throw fail('qr-show', 'Ptlogin QR has no qrsig');
  return { qrsig, imageUrl: await imageOf(response), expiresIn: PTLOGIN_QR_TTL_SECONDS };
};

const STRING_ARGUMENT = /^'((?:[^'\\\r\n]|\\(?:['\\nrt]|x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}))*)'\s*/;

/** 把 `ptuiCB('a','b',…)` 拆成字符串参数；任何不是这个形状的回包都当失败。 */
const ptuiArgumentsOf = (body: string): string[] => {
  const outer = /^\s*ptuiCB\((.*)\);?\s*$/s.exec(body);
  if (!outer) throw fail('qr-poll', 'Ptlogin poll response is malformed');
  const values: string[] = [];
  let rest = outer[1].trim();
  while (rest) {
    const match = STRING_ARGUMENT.exec(rest);
    if (!match) throw fail('qr-poll', 'Ptlogin poll response is malformed');
    values.push(
      match[1].replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|['\\nrt])/g, (_, escaped: string) => {
        if (escaped.startsWith('x') || escaped.startsWith('u'))
          return String.fromCharCode(Number.parseInt(escaped.slice(1), 16));
        return ({ n: '\n', r: '\r', t: '\t' } as Record<string, string>)[escaped] ?? escaped;
      }),
    );
    rest = rest.slice(match[0].length);
    if (!rest) break;
    if (!rest.startsWith(',') || values.length >= 7)
      throw fail('qr-poll', 'Ptlogin poll response is malformed');
    rest = rest.slice(1).trim();
    if (!rest) throw fail('qr-poll', 'Ptlogin poll response is malformed');
  }
  if (values.length < 6 || values.length > 7 || !/^\d{1,9}$/.test(values[0]))
    throw fail('qr-poll', 'Ptlogin poll response is malformed');
  return values;
};

/** 查一次二维码状态。每次只发一个请求，不等待、不重试。 */
export const pollPtloginQr = async (
  qrsig: string,
  options: PtloginOptions = {},
): Promise<PtloginPoll> => {
  if (!COOKIE_VALUE.test(qrsig)) throw fail('qr-poll', 'Ptlogin qrsig is invalid');
  const url = new URL(`${PTLOGIN_HOST}/ssl/ptqrlogin`);
  url.search = new URLSearchParams({
    u1: LOGIN_JUMP,
    from_ui: '1',
    aid: PTLOGIN_APP_ID,
    daid: '383',
    pt_3rd_aid: CONNECT_CLIENT_ID,
    ptqrtoken: String(hash33(qrsig, 0)),
  }).toString();
  const response = await send(
    'qr-poll',
    url.toString(),
    { method: 'GET', headers: { cookie: `qrsig=${qrsig}` } },
    options,
  );
  const [rawCode, , signatureUrl] = ptuiArgumentsOf(await textOf('qr-poll', response));
  const code = Number(rawCode);
  if (code === 66) return { status: 'waiting' };
  if (code === 67) return { status: 'scanned' };
  if (code === 65) return { status: 'expired' };
  if (code !== 0)
    throw fail('qr-poll', 'Ptlogin poll returned an unknown code', { upstreamCode: code });
  const checkSig = trustedUrl('qr-poll', signatureUrl, 'ssl.ptlogin2.graph.qq.com', '/check_sig');
  return { status: 'confirmed', checkSigUrl: checkSig.toString() };
};

const randomState = (): string => {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
};

const credentialOf = (data: unknown): QqCredential => {
  const credential = (data ?? {}) as QqCredential;
  const musicid = Number(credential.musicid);
  const expiresAt =
    typeof data === 'object' && data !== null ? credentialExpiryAt(credential) : null;
  if (
    typeof data !== 'object' ||
    data === null ||
    credential.loginType !== 2 ||
    typeof credential.musickey !== 'string' ||
    !credential.musickey ||
    !/^\d+$/.test(String(credential.musicid)) ||
    !Number.isSafeInteger(musicid) ||
    musicid <= 0 ||
    (expiresAt !== null && expiresAt <= Date.now())
  )
    throw fail('qq-login', 'Ptlogin credential is invalid');
  return credential;
};

/**
 * 手机上确认之后，用 `check_sig` 网址一路换到 QQ 音乐的凭证。`state` 每次随机，回跳带回来的值要一样。
 * 中间拿到的 QQ 全局 Cookie 只在这个函数里用，不保存、不交出去。
 */
export const exchangePtloginCredential = async (
  checkSigUrl: string,
  options: PtloginOptions & { state?: string } = {},
): Promise<QqCredential> => {
  const signature = trustedUrl('check-sig', checkSigUrl, 'ssl.ptlogin2.graph.qq.com', '/check_sig');
  const checked = await send('check-sig', signature.toString(), { method: 'GET' }, options);
  if (checked.status !== 302) throw fail('check-sig', 'Ptlogin check_sig did not redirect');
  const jump = trustedUrl(
    'check-sig',
    checked.headers.get('location') ?? '',
    'graph.qq.com',
    '/oauth2.0/login_jump',
  );
  const values = GRAPH_COOKIES.map((name) => cookieOf(checked, name, 'graph.qq.com'));
  if (values.some((value) => !value)) throw fail('check-sig', 'Ptlogin graph cookies are missing');
  const cookie = GRAPH_COOKIES.map((name, index) => `${name}=${values[index]}`).join('; ');

  const jumped = await send('login-jump', jump.toString(), { method: 'GET' }, options);
  void jumped.body?.cancel().catch(() => undefined);
  if (jumped.status !== 200) throw fail('login-jump', 'Ptlogin login_jump failed');

  const state = options.state ?? randomState();
  const redirectUri = new URL(REDIRECT);
  redirectUri.search = new URLSearchParams({
    login_type: '1',
    surl: 'https://y.qq.com/',
  }).toString();
  const form = new URLSearchParams({
    response_type: 'code',
    client_id: CONNECT_CLIENT_ID,
    redirect_uri: redirectUri.toString(),
    scope: SCOPE,
    state,
    switch: '',
    from_ptlogin: '1',
    src: '1',
    update_auth: '1',
    openapi: '1010_1030',
    g_tk: String(hash33(values[1] as string, 5381)),
    auth_time: String(Date.now()),
    ui: crypto.randomUUID(),
  });
  const authorized = await send(
    'authorize',
    AUTHORIZE,
    {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    },
    options,
  );
  if (authorized.status !== 302) throw fail('authorize', 'Ptlogin authorize did not redirect');
  const back = trustedUrl(
    'authorize',
    authorized.headers.get('location') ?? '',
    'y.qq.com',
    '/portal/wx_redirect.html',
  );
  const codes = back.searchParams.getAll('code');
  const states = back.searchParams.getAll('state');
  if (codes.length !== 1 || !/^[A-F0-9]{32}$/.test(codes[0]))
    throw fail('authorize', 'Ptlogin authorization code is missing');
  if (states.length !== 1 || states[0] !== state)
    throw fail('authorize', 'Ptlogin state does not match');

  const exchanged = await send(
    'qq-login',
    MUSICU,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: JSON.stringify({
        comm: { g_tk: 5381, platform: 'yqq', ...WEB_ANONYMOUS_COMM },
        req: { module: 'QQConnectLogin.LoginServer', method: 'QQLogin', param: { code: codes[0] } },
      }),
    },
    options,
  );
  let body: { code?: unknown; req?: { code?: unknown; data?: unknown } };
  try {
    body = JSON.parse(await textOf('qq-login', exchanged));
  } catch (error) {
    if (error instanceof PtloginError) throw error;
    throw fail('qq-login', 'Ptlogin credential is invalid');
  }
  const globalCode = typeof body?.code === 'number' ? body.code : undefined;
  const requestCode = typeof body?.req?.code === 'number' ? body.req.code : undefined;
  if (globalCode !== 0 || requestCode !== 0)
    throw fail('qq-login', 'Ptlogin QQLogin was rejected', {
      upstreamCode: requestCode,
      globalCode,
    });
  return credentialOf(body.req?.data);
};
