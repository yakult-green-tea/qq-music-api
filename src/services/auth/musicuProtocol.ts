import { androidUserAgent } from '../../protocol/clientProfiles';
import { logger } from '../../util/logger';
import type { UpstreamPhase } from '../../util/safeError';
import { type Dictionary, dictionaryOf, identifierOf, numberOf } from '../../util/values';
import { type AndroidDevice, buildAndroidComm } from './androidDevice';
import type { AuthHttpClient } from './httpClient';
import { type QqCredential, type QrFailureDiagnostics } from './qrTypes';

// src/services/auth/musicuProtocol.ts
// 从认证入口搬出的同一套实现；协议、状态与对外回包沿用原规则。

export const MUSICU_URL = 'https://u.y.qq.com/cgi-bin/musicu.fcg';

export class QrLoginServiceError extends Error {
  public constructor(
    message: string,
    public readonly httpStatus: number,
    public readonly retryAfterMs?: number,
    public readonly upstreamCode?: number,
    public readonly diagnostics: QrFailureDiagnostics = {},
  ) {
    super(message);
    this.name = 'QrLoginServiceError';
  }
}

/**
 * QIMEI bootstrap rejection. Only the upstream numeric codes are carried; they are opaque
 * security codes and must never be renamed into an official error meaning.
 */
export class QqDeviceBootstrapError extends Error {
  public constructor(
    public readonly httpStatus: number,
    public readonly outerCode: number | undefined,
    public readonly innerCode: number | undefined,
  ) {
    super(
      `QIMEI bootstrap failed (HTTP ${httpStatus}, outer=${outerCode ?? 'unknown'}, inner=${innerCode ?? 'unknown'})`,
    );
    this.name = 'QqDeviceBootstrapError';
  }
}

export class QqProtocolError extends Error {
  public constructor(
    public readonly phase: string,
    public readonly upstreamCode: number | undefined,
    public readonly globalCode: number,
    public readonly httpStatus: number,
  ) {
    super(
      `${phase} failed (HTTP ${httpStatus}, global=${globalCode}, code=${upstreamCode ?? 'unknown'})`,
    );
    this.name = 'QqProtocolError';
  }
}

/** The cookie form of a credential, accepted by both the musicu RPC face and the legacy CGIs. */
export const credentialCookieHeader = (credential: QqCredential): string => {
  const musicid = identifierOf(credential.str_musicid) || String(credential.musicid);
  return [
    `uin=${musicid}`,
    `qqmusic_uin=${musicid}`,
    `qm_keyst=${credential.musickey}`,
    `qqmusic_key=${credential.musickey}`,
  ].join('; ');
};

/**
 * 要原样写进请求体的十进位整数。微信账号的 id 是 19 位，超过 JavaScript 能精确表示的整数；
 * 上游要的是不带引号的数字，`Number()` 会变成另一个数，送字符串又会被拒。
 */
export class ExactInteger {
  constructor(readonly digits: string) {
    if (!/^\d{1,40}$/.test(digits)) throw new Error('ExactInteger needs decimal digits');
  }
}

const EXACT_MARK = '\u0000exact:';

const hasExactInteger = (value: unknown): boolean =>
  value instanceof ExactInteger ||
  (Array.isArray(value)
    ? value.some(hasExactInteger)
    : typeof value === 'object' && value !== null && Object.values(value).some(hasExactInteger));

/** 先序列化，再把占位的字符串换回不带引号的数字。只有带 `ExactInteger` 的请求才走这里。 */
export const serializeWithExactIntegers = (value: unknown): string =>
  JSON.stringify(value, (_key, entry) =>
    entry instanceof ExactInteger ? `${EXACT_MARK}${entry.digits}` : entry,
  ).replace(/"\\u0000exact:(\d+)"/g, '$1');

/**
 * 安卓客户端请求的标头：User-Agent 跟着设备的系统版本，带凭证时再加账号 Cookie。
 * 登录服务和新路由的上游客户端都用这一份。
 */
export const androidRequestHeaders = (
  device: AndroidDevice,
  credential?: QqCredential,
): Record<string, string> => ({
  'User-Agent': androidUserAgent(device.osRelease),
  ...(credential ? { Cookie: credentialCookieHeader(credential) } : {}),
});

export const callMusicu = async (
  http: AuthHttpClient,
  device: AndroidDevice,
  phase: UpstreamPhase,
  module: string,
  method: string,
  param: Dictionary,
  credential?: QqCredential,
  overrides: Dictionary = {},
): Promise<Dictionary> => {
  const credentialCookies = credential ? credentialCookieHeader(credential) : '';
  const request = {
    comm: buildAndroidComm(device, credential, overrides),
    req_0: { module, method, param },
  };
  // 带不失真长整数的请求自己先序列化（两个宿主的 HTTP 客户端都会原样送出字符串），其他请求照旧。
  const exact = hasExactInteger(param);
  const response = await http.post<unknown>(
    MUSICU_URL,
    exact ? serializeWithExactIntegers(request) : request,
    {
      headers: {
        'User-Agent': androidUserAgent(device.osRelease),
        ...(exact ? { 'Content-Type': 'application/json' } : {}),
        ...(credentialCookies ? { Cookie: credentialCookies } : {}),
      },
    },
  );
  const body = dictionaryOf(response.data);
  const item = dictionaryOf(body.req_0);
  const globalCode = numberOf(body.code) ?? 0;
  const upstreamCode = numberOf(item.code);
  logger.info('qq-auth.upstream-result', {
    phase,
    httpStatus: response.status,
    globalCode,
    upstreamCode,
  });
  if (!Object.keys(item).length || globalCode !== 0 || (upstreamCode ?? 0) !== 0) {
    throw new QqProtocolError(phase, upstreamCode, globalCode, response.status);
  }
  return dictionaryOf(item.data);
};
