import { logger } from '../../util/logger';
import type { AuthHttpClient } from './httpClient';
import type { QrEvent } from './qrLogin';

// WeChat QR login channel (`tmeLoginType: 1`).
//
// This is the *web* OAuth flow: open.weixin.qq.com hands out a QR whose confirmation yields a
// WeChat OAuth `code`, which is then swapped for a QQ Music credential. It shares nothing with
// the QQ Music App channel (`tmeLoginType: 6`, MQTT over WSS) beyond that final musicu call,
// which stays in `qrLogin.ts` because it needs the Android device context that these endpoints
// must NOT receive.
//
// Endpoints, the appid and the status codes below are third-party reverse-engineered protocol
// facts taken from `L-1124/QQMusicApi` (`qqmusic_api/modules/login.py`,
// `qqmusic_api/models/login.py`, pinned commit 8ec78ce3f16805ebe470b8308a96fef925cf8e56).
// They are NOT official Tencent definitions. Unrecognised upstream numbers stay opaque safe
// codes and are never renamed into an official error meaning.
//
// This module must not import anything from `qrLogin.ts` at runtime (type-only imports are
// erased): `qrLogin.ts` imports this file, and a runtime cycle would break module init.

export const WECHAT_APP_ID = 'wx48db31d50e334801';
export const WECHAT_LOGIN_TYPE = 1;

const CONNECT_URL = 'https://open.weixin.qq.com/connect/qrconnect';
const IMAGE_URL_PREFIX = 'https://open.weixin.qq.com/connect/qrcode/';
const POLL_URL = 'https://lp.open.weixin.qq.com/connect/l/qrconnect';
const REDIRECT_URI = 'https://y.qq.com/portal/wx_redirect.html?login_type=2&surl=https://y.qq.com/';
const STYLE_HREF = 'https://y.qq.com/mediastyle/music_v17/src/css/popup_wechat.css#wechat_redirect';
const POLL_REFERER = 'https://open.weixin.qq.com/';

const UUID_PATTERN = /uuid=(.+?)"/;
const STATUS_PATTERN = /window\.wx_errcode=(\d+);window\.wx_code='([^']*)'/;

const PNG_MAGIC = '89504e470d0a1a0a';
const JPEG_MAGIC = 'ffd8ff';

/**
 * How long one long poll may hold the connection. The upstream keeps it open until the QR state
 * changes, so the caller's budget — not a fixed interval — is what bounds a `check`.
 */
export const WECHAT_DEFAULT_POLL_BUDGET_MS = 1500;
export const MAX_CONSECUTIVE_POLL_ERRORS = 3;

/**
 * `window.wx_errcode` values. The reference pairs each state with its QQ `ptuiCB` counterpart;
 * only the WeChat column is used here.
 */
export const WECHAT_STATUS = {
  waiting: 408,
  scanned: 404,
  confirmed: 405,
  expired: 402,
  refused: 403,
} as const;

export interface WechatQr {
  identifier: string;
  imageUrl: string;
}

export interface WechatQrStatus {
  upstreamCode: number;
  code: string;
}

export interface WechatRequestOptions {
  /** Aborts the upstream request when the caller goes away or its deadline passes. */
  signal?: AbortSignal;
}

export interface WechatPollOptions extends WechatRequestOptions {
  /** Caps how long the long poll may hold; the upstream is aborted when it elapses. */
  budgetMs?: number;
}

/**
 * A WeChat channel failure that still carries the upstream number as an opaque safe code.
 */
export class WechatQrError extends Error {
  public constructor(
    message: string,
    public readonly upstreamCode?: number,
  ) {
    super(message);
    this.name = 'WechatQrError';
  }
}

const textOf = (value: unknown): string => (typeof value === 'string' ? value : '');

const bufferOf = (value: unknown): Buffer => {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value))
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  return Buffer.alloc(0);
};

const imageMimetype = (image: Buffer): string | null => {
  const head = image.subarray(0, 8).toString('hex');
  if (head.startsWith(PNG_MAGIC)) return 'image/png';
  if (head.startsWith(JPEG_MAGIC)) return 'image/jpeg';
  return null;
};

/**
 * Merges the caller's abort signal with a deadline. Both runtimes this package targets ship
 * `AbortSignal.any` and `AbortSignal.timeout`, so an upstream request never outlives its budget.
 */
const budgetSignal = (budgetMs?: number, signal?: AbortSignal): AbortSignal | undefined => {
  if (budgetMs === undefined) return signal;
  const deadline = AbortSignal.timeout(Math.max(1, budgetMs));
  return signal ? AbortSignal.any([signal, deadline]) : deadline;
};

/**
 * Fetches the QR image for a `uuid` already obtained from `createWechatQr`, as an inline data URL.
 * Split out so a caller that already knows the `uuid` — a serverless invocation reconstructing a
 * session from a sealed `unikey`, which never carries the image itself — can re-fetch just the
 * image without minting a second, different WeChat QR through a new `qrconnect` call.
 */
export const fetchWechatQrImage = async (
  http: AuthHttpClient,
  uuid: string,
  options: WechatRequestOptions = {},
): Promise<string> => {
  const image = await http.request<unknown>({
    url: `${IMAGE_URL_PREFIX}${uuid}`,
    method: 'GET',
    headers: { Referer: CONNECT_URL },
    responseType: 'arraybuffer',
    signal: options.signal,
  });
  const bytes = bufferOf(image.data);
  const mimetype = imageMimetype(bytes);
  if (!mimetype) throw new WechatQrError('WeChat QR response is not a PNG/JPEG image');
  logger.info('qq-auth.wechat-qr-image-fetched', {
    qrIdentifierLength: uuid.length,
    imageBytes: bytes.length,
    mimetype,
  });
  return `data:${mimetype};base64,${bytes.toString('base64')}`;
};

/**
 * Requests a WeChat QR and returns its `uuid` plus an inline data URL, so the transport keeps
 * handing the client a self-contained image exactly like the App channel does.
 */
export const createWechatQr = async (
  http: AuthHttpClient,
  options: WechatRequestOptions = {},
): Promise<WechatQr> => {
  const page = await http.request<string>({
    url: CONNECT_URL,
    method: 'GET',
    params: {
      appid: WECHAT_APP_ID,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      scope: 'snsapi_login',
      state: 'STATE',
      href: STYLE_HREF,
    },
    responseType: 'text',
    signal: options.signal,
  });
  const uuid = UUID_PATTERN.exec(textOf(page.data))?.[1] ?? '';
  if (!uuid) throw new WechatQrError('WeChat qrconnect response missing uuid');

  return { identifier: uuid, imageUrl: await fetchWechatQrImage(http, uuid, options) };
};

/**
 * One long-poll of the WeChat QR state. The endpoint holds the connection open until the state
 * changes, so the caller does not need to poll aggressively.
 */
export const pollWechatQr = async (
  http: AuthHttpClient,
  uuid: string,
  options: WechatPollOptions = {},
): Promise<WechatQrStatus> => {
  const response = await http.request<string>({
    url: POLL_URL,
    method: 'GET',
    params: { uuid, _: String(Date.now()) },
    headers: { Referer: POLL_REFERER },
    responseType: 'text',
    signal: budgetSignal(options.budgetMs, options.signal),
  });
  const match = STATUS_PATTERN.exec(textOf(response.data));
  if (!match) throw new WechatQrError('WeChat poll response missing wx_errcode');
  return { upstreamCode: Number(match[1]), code: match[2] };
};

/**
 * Maps one poll result onto the event vocabulary the App channel listener uses, so the session
 * state machine stays channel-agnostic.
 */
export const eventForWechatStatus = (status: WechatQrStatus): QrEvent => {
  switch (status.upstreamCode) {
    case WECHAT_STATUS.waiting:
      return { type: 'waiting', payload: null };
    case WECHAT_STATUS.scanned:
      return { type: 'scanned', payload: null };
    case WECHAT_STATUS.confirmed:
      return { type: 'authorized', payload: { code: status.code } };
    case WECHAT_STATUS.expired:
      return { type: 'timeout', payload: null };
    case WECHAT_STATUS.refused:
      return { type: 'canceled', payload: null };
    default:
      throw new WechatQrError('Unrecognised WeChat QR status', status.upstreamCode);
  }
};
