/**
 * 把任意异常收敛成可以安全对外的摘要：旧路由的 500 回应和日志都只用它，不再直接带出原始异常。
 *
 * 原始异常（尤其是 AxiosError）会带着 config、请求地址、header、body、stack，甚至凭证和账号、
 * 设备标识。这里只按白名单挑出几样东西：已知的错误名、已知的网络错误码、合法的 HTTP 状态码、
 * 已知的协议阶段和安全整数业务码；message 一律由固定模板生成，不会出现原始文字。
 *
 * 这个模块不 import 任何东西：serverless 和日志路径都会用到它，依赖闭包必须保持干净。
 * 协议错误按 name 和字段识别，而不是 import 登录模块的类；字段不合法时退回通用摘要。
 */

/** `callMusicu` 等协议调用使用的阶段名；不在这里的阶段不会出现在回应或日志中。 */
export const UPSTREAM_PHASES = [
  'get-music-play',
  'get-music-play-retry',
  'get-playback-hint',
  'get-preview-detail',
  'get-quality-detail',
  'get-user-vip',
  'get-user-music-gene',
  'playlist-track-write',
  'playlist-subscribe',
  'song-like',
  'album-subscribe',
  'playlist-create',
  'playlist-delete',
  'playlist-rename',
  'subscription-status',
  'get-cdn-dispatch',
  'get-session',
  'create-qr',
  'credential-exchange',
  'get-login-user',
  'credential-refresh',
  'get-user-playlists',
  'get-user-favorite-playlists',
  'get-created-playlist-play-counts',
  'get-favorite-playlist-play-counts',
  'get-user-favorite-albums',
  'get-song-list-detail',
  'get-owned-playlist-songs',
  'get-user-liked-songs',
  'get-guess-you-like',
  'get-daily-songs',
  'get-daily-history',
  'get-blacklist',
  'blacklist-add',
  'blacklist-remove',
  'get-blacklist-style-options',
  'get-user-cloud',
  'get-recommend-playlists',
  'get-radio-list',
  'get-radio-tracks',
  'get-radio-recommendation-modes',
  'get-radio-recommendation-tracks',
  'get-guess-you-like-modes',
  'get-recommendation-preferences',
  'recommendation-preferences-write',
  'get-playlist-categories',
  'get-category-playlists',
  'get-new-songs',
  'get-new-albums',
  'get-radar',
  'get-similar-songs',
  'get-related-playlists',
  'get-toplists',
  'get-toplist',
  'search',
  'search-users',
  'get-hot-searches',
  'get-search-suggestions',
  'get-singer-list',
  'get-singer-detail',
  'get-singer-homepage',
  'get-similar-singers',
  'get-singer-songs',
  'get-singer-mvs',
  'get-hot-comments',
  'get-new-comments',
  'get-comment-count',
  'get-mv-list',
  'get-mv-detail',
  'get-mv-url',
  'get-song-mvs',
  'get-song-labels',
  'get-song-fav-count',
  'get-song-versions',
  'get-song-replacement',
  'get-search-match',
  'get-all-playlist-categories',
  'get-sorted-category-playlists',
  'get-song-batch',
  'get-radio-categories',
  'get-comment-list',
] as const;

export type UpstreamPhase = (typeof UPSTREAM_PHASES)[number];

/** 旧路由 500 回应里 `error` 对象的形状，键名沿用 AxiosError 序列化后的同名字段。 */
export interface LegacyErrorBody {
  name: string;
  message: string;
  code?: string;
  status?: number;
}

/** 日志用的摘要，比回应多带协议阶段和业务码。 */
export interface SafeErrorSummary extends LegacyErrorBody {
  stage?: UpstreamPhase | 'device-bootstrap';
  upstreamCode?: number;
  globalCode?: number;
  /** 只给开发日志看的具体原因，来自下面登记过的固定文字，不会出现在对外回应里。 */
  reason?: string;
}

const GENERIC_MESSAGE = 'Service request failed';

const SAFE_NAMES = new Set([
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'AxiosError',
  'CanceledError',
  'AbortError',
  'TimeoutError',
  'QqProtocolError',
  'QqDeviceBootstrapError',
  'AuthCredentialRejectedError',
  'RequestRejectedError',
  'QrLoginServiceError',
  'WechatQrError',
  'SealedSessionError',
  'SessionCryptoError',
]);

/**
 * 程序自己抛出的固定文字。日志用它们说明具体原因；不在这里的文字一律不记录，因为它可能夹带
 * 地址、凭证或调用方输入。新增固定文字时要登记，`tests/safeError.reasons.test.ts` 会扫描 src 检查。
 */
const KNOWN_REASONS = new Set([
  'A session secret is required',
  'A session secret is required to open state',
  'A session secret is required to seal state',
  'Another QR login is already active',
  'CreateQRCode response missing a valid PNG/qrcodeID',
  'Credential exchange ran out of time',
  'Decrypted state is not valid JSON',
  'ExactInteger needs decimal digits',
  'GetSession response missing uid/sid',
  'Login credential is missing encryptUin',
  'Login response missing credential',
  'MQTT WebSocket closed',
  'MQTT WebSocket error',
  'MQTT cookies missing login credential',
  'MQTT handshake failed',
  'MQTT handshake timeout',
  'MQTT packet timeout',
  'MQTT redirect limit exceeded',
  'Malformed MQTT variable integer',
  'Ptlogin QQLogin was rejected',
  'Ptlogin QR cannot be redrawn',
  'Ptlogin QR has no qrsig',
  'Ptlogin QR image is not a PNG',
  'Ptlogin authorization code is missing',
  'Ptlogin check_sig URL is missing',
  'Ptlogin check_sig did not redirect',
  'Ptlogin credential is invalid',
  'Ptlogin graph cookies are missing',
  'Ptlogin login_jump failed',
  'Ptlogin poll response is malformed',
  'Ptlogin poll returned an unknown code',
  'Ptlogin qrsig is invalid',
  'Ptlogin redirect is not allowed',
  'Ptlogin response too large',
  'Ptlogin state does not match',
  'Ptlogin upstream HTTP error',
  'QQ auth redirect limit exceeded',
  'QR login is temporarily backed off',
  'QR session cannot create another code',
  'QR session has no upstream QR after createQr()',
  'QR session not found or expired',
  'RSAES-PKCS1-v1_5 payload too long for this key',
  'Request body must be a JSON object.',
  'Sealed payload is not valid JSON',
  'State failed authentication',
  'State is not a readable envelope',
  'State was written by an unsupported envelope version',
  'Token failed authentication',
  'Token field iv has an unusable length',
  'Token is not a sealed session',
  'Token was sealed by an unknown key',
  'Token was sealed for another purpose',
  'Truncated MQTT CONNACK',
  'Truncated MQTT PUBLISH',
  'Truncated MQTT properties',
  'Truncated MQTT subscription identifier',
  'Unable to create QR login',
  'Unable to start QR login',
  'Unrecognised WeChat QR status',
  'Unsupported MQTT WebSocket payload',
  'uid must be the logged-in account',
  'WeChat QR response is not a PNG/JPEG image',
  'WeChat authorization missing code',
  'WeChat poll response missing wx_errcode',
  'WeChat qrconnect response missing uuid',
]);

/** 由字段名或十六进制码组成的固定模板；整句都必须吻合，多一个字都不算。 */
const KNOWN_REASON_PATTERNS = [
  /^MQTT (?:CONNACK|SUBACK) rejected: 0x[0-9a-f]{1,2}$/,
  /^Unsupported MQTT property 0x[0-9a-f]{1,2}$/,
  /^QQ auth request failed with status [1-5]\d{2}$/,
  /^Token field [a-z]{1,16} is not base64url$/,
  /^Envelope field [a-z]{1,16} (?:is missing|has an unusable length)$/,
];

/** 很长的配置错误只记录开头那句固定说明。 */
const KNOWN_REASON_PREFIXES = [
  'Legacy QQ HTTP transport is not registered',
  'No AuthHttpClient was provided',
  'The QQ App channel needs an MQTT listener and this runtime has none',
];

const TIMEOUT_CODES = new Set([
  'ETIMEDOUT',
  'ECONNABORTED',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

const NETWORK_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'ERR_NETWORK',
  'UND_ERR_SOCKET',
]);

const SAFE_CODES = new Set([
  ...TIMEOUT_CODES,
  ...NETWORK_CODES,
  'ERR_CANCELED',
  'ERR_BAD_RESPONSE',
  'ERR_BAD_REQUEST',
  'ERR_FR_TOO_MANY_REDIRECTS',
]);

const PHASES = new Set<string>(UPSTREAM_PHASES);

/** getter 可能抛错、值可能是任意类型；读不到就当作没有。 */
const read = (value: unknown, key: string): unknown => {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null)
    return undefined;
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
};

const safeInteger = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;

const httpStatus = (value: unknown): number | undefined => {
  const status = safeInteger(value);
  return status !== undefined && status >= 100 && status <= 599 ? status : undefined;
};

const safeCode = (value: unknown): string | undefined =>
  typeof value === 'string' && SAFE_CODES.has(value) ? value : undefined;

const safeName = (value: unknown): string =>
  typeof value === 'string' && SAFE_NAMES.has(value) ? value : 'Error';

const codeOrUnknown = (value: number | undefined): string =>
  value === undefined ? 'unknown' : String(value);

/** `QqProtocolError`：阶段、HTTP 状态和两个业务码都合法才认，否则交给通用规则。 */
const protocolSummary = (error: unknown): SafeErrorSummary | undefined => {
  const status = httpStatus(read(error, 'httpStatus'));
  const globalCode = safeInteger(read(error, 'globalCode'));
  const rawUpstreamCode = read(error, 'upstreamCode');
  const upstreamCode = safeInteger(rawUpstreamCode);
  if (status === undefined || globalCode === undefined) return undefined;
  if (rawUpstreamCode !== undefined && upstreamCode === undefined) return undefined;
  const phase = read(error, 'phase');
  const stage =
    typeof phase === 'string' && PHASES.has(phase) ? (phase as UpstreamPhase) : undefined;
  return {
    name: 'QqProtocolError',
    message: `${stage ?? 'Upstream request'} failed (HTTP ${status}, global=${globalCode}, code=${codeOrUnknown(upstreamCode)})`,
    status,
    ...(stage === undefined ? {} : { stage }),
    ...(upstreamCode === undefined ? {} : { upstreamCode }),
    globalCode,
  };
};

const bootstrapSummary = (error: unknown): SafeErrorSummary | undefined => {
  const status = httpStatus(read(error, 'httpStatus'));
  const rawOuter = read(error, 'outerCode');
  const rawInner = read(error, 'innerCode');
  const outer = safeInteger(rawOuter);
  const inner = safeInteger(rawInner);
  if (status === undefined) return undefined;
  if (
    (rawOuter !== undefined && outer === undefined) ||
    (rawInner !== undefined && inner === undefined)
  )
    return undefined;
  return {
    name: 'QqDeviceBootstrapError',
    message: `QIMEI bootstrap failed (HTTP ${status}, outer=${codeOrUnknown(outer)}, inner=${codeOrUnknown(inner)})`,
    status,
    stage: 'device-bootstrap',
    ...(outer === undefined ? {} : { upstreamCode: outer }),
  };
};

const reasonOf = (error: unknown): string | undefined => {
  const message = read(error, 'message');
  if (typeof message !== 'string') return undefined;
  if (KNOWN_REASONS.has(message)) return message;
  if (KNOWN_REASON_PATTERNS.some((pattern) => pattern.test(message))) return message;
  return KNOWN_REASON_PREFIXES.find((prefix) => message.startsWith(`${prefix}.`));
};

const summarize = (error: unknown): SafeErrorSummary => {
  const name = safeName(read(error, 'name'));
  if (name === 'QqProtocolError') {
    const summary = protocolSummary(error);
    if (summary) return summary;
  }
  if (name === 'QqDeviceBootstrapError') {
    const summary = bootstrapSummary(error);
    if (summary) return summary;
  }
  if (name === 'AuthCredentialRejectedError') {
    const upstreamCode = safeInteger(read(error, 'upstreamCode'));
    return {
      name,
      message: 'Login required',
      ...(upstreamCode === undefined ? {} : { upstreamCode }),
    };
  }

  const code = safeCode(read(error, 'code')) ?? safeCode(read(read(error, 'cause'), 'code'));
  const status =
    httpStatus(read(read(error, 'response'), 'status')) ??
    httpStatus(read(error, 'httpStatus')) ??
    httpStatus(read(error, 'status'));
  const wechatCode =
    name === 'WechatQrError' ? safeInteger(read(error, 'upstreamCode')) : undefined;
  const extras = {
    ...(code === undefined ? {} : { code }),
    ...(status === undefined ? {} : { status }),
    ...(wechatCode === undefined ? {} : { upstreamCode: wechatCode }),
  };

  if (status !== undefined)
    return { name, message: `Upstream request failed (HTTP ${status})`, ...extras };
  if (name === 'TimeoutError' || (code !== undefined && TIMEOUT_CODES.has(code)))
    return { name, message: 'Upstream request timed out', ...extras };
  if (name === 'AbortError' || name === 'CanceledError' || code === 'ERR_CANCELED')
    return { name, message: 'Upstream request was canceled', ...extras };
  if (code !== undefined && NETWORK_CODES.has(code))
    return { name, message: `Upstream request failed (${code})`, ...extras };
  return { name, message: GENERIC_MESSAGE, ...extras };
};

/** 任意异常 → 日志可用的安全摘要；认得的固定文字另外放进 `reason`。 */
export const summarizeError = (error: unknown): SafeErrorSummary => {
  const summary = summarize(error);
  const reason = reasonOf(error);
  return reason === undefined ? summary : { ...summary, reason };
};

/** 旧曲库服务 500 回应里的 `error` 对象：只保留名称、固定文案、白名单错误码和上游状态码。 */
export const toLegacyErrorBody = (error: unknown): LegacyErrorBody => {
  const { name, message, code, status } = summarizeError(error);
  return {
    name,
    message,
    ...(code === undefined ? {} : { code }),
    ...(status === undefined ? {} : { status }),
  };
};

/** 控制器层与 serverless 兜底 500 回应里的 `error` 字符串。 */
export const toLegacyErrorMessage = (error: unknown): string => summarizeError(error).message;
