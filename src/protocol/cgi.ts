import type { UpstreamOperation } from './businessCodes';
import { normalizeQqFailure, QqApiError } from './errors';
import { withDeadline } from './http';
import type { TokenBucket } from './tokenBucket';

// src/protocol/cgi.ts
//
// 匿名旧 CGI（c.y.qq.com 的 *.fcg）读取：一次 GET、整个过程一个截止时间，回包按 UTF-8 解码，
// 不合法再试 GB18030，去掉 JSONP 外壳后检查 code / subcode。两个宿主共用，HTTP 由传输层注入。

export interface CgiRequest {
  url: string;
  headers: Record<string, string>;
  signal: AbortSignal;
  maxBytes?: number;
}

export interface CgiResponse {
  status: number;
  retryAfterMs?: number;
  /** 只有 2xx 才读回包；其余状态的回包传输层直接丢掉。 */
  bytes?: ArrayBuffer;
}

export type CgiTransport = (request: CgiRequest) => Promise<CgiResponse>;

/** 传输层观察到的网络失败：只留原生错误的 name 和 code，不带原文、网址或凭证。 */
export class CgiNetworkError extends Error {
  public readonly nativeName?: string;
  public readonly code?: string;

  constructor(observation: { name?: string; code?: string }) {
    super('CGI transport failed');
    this.name = 'CgiNetworkError';
    this.nativeName = observation.name;
    this.code = observation.code;
  }
}

export interface CgiReadOptions {
  operation: UpstreamOperation;
  http: CgiTransport;
  /** 每次发出请求前取一个令牌；不给就不限流。 */
  limiter?: TokenBucket;
  timeoutMs?: number;
}

export type CgiData = Record<string, unknown>;

const networkFailure = (error: unknown, operation: UpstreamOperation): QqApiError => {
  if (error instanceof QqApiError) return error;
  const observed =
    error instanceof CgiNetworkError ? { name: error.nativeName, code: error.code } : error;
  return normalizeQqFailure({ source: 'network', error: observed }, { operation, readOnly: true });
};

const decode = (bytes: ArrayBuffer): unknown => {
  try {
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      text = new TextDecoder('gb18030', { fatal: true }).decode(bytes);
    }
    const jsonp = /^\w+\(([\s\S]*)\);?\s*$/.exec(text);
    return JSON.parse(jsonp ? jsonp[1] : text);
  } catch {
    throw new QqApiError('invalid-response');
  }
};

const checked = (body: unknown, operation: UpstreamOperation): CgiData => {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new QqApiError('invalid-response');
  const data = body as CgiData;
  if (typeof data.code !== 'number' || !Number.isSafeInteger(data.code))
    throw new QqApiError('invalid-response');
  if (data.code !== 0)
    throw normalizeQqFailure({ source: 'business', upstreamCode: data.code }, { operation });
  if (data.subcode !== undefined) {
    if (typeof data.subcode !== 'number' || !Number.isSafeInteger(data.subcode))
      throw new QqApiError('invalid-response');
    if (data.subcode !== 0)
      throw normalizeQqFailure({ source: 'business', upstreamCode: data.subcode }, { operation });
  }
  return data;
};

/** 读一次，不重试；`origin` 加 `path` 是上游地址，`params` 之外固定带 `format=json&outCharset=utf-8`。 */
export const readCgi = (
  origin: string,
  path: string,
  params: Record<string, string | number>,
  options: CgiReadOptions,
): Promise<CgiData> => {
  const { operation } = options;
  const url = new URL(path, origin);
  url.search = new URLSearchParams(
    Object.entries({
      format: 'json',
      outCharset: 'utf-8',
      ...params,
    }).map(([key, value]) => [key, String(value)]),
  ).toString();
  return withDeadline(async (signal) => {
    await options.limiter?.acquire(signal);
    let response: CgiResponse;
    try {
      response = await options.http({
        url: url.toString(),
        headers: { Referer: 'https://y.qq.com/' },
        signal,
      });
    } catch (error) {
      throw networkFailure(error, operation);
    }
    if (response.status >= 300 && response.status < 400)
      throw new QqApiError('upstream-http', { upstreamHttpStatus: response.status });
    if (response.status < 200 || response.status >= 300)
      throw normalizeQqFailure(
        {
          source: 'http',
          upstreamHttpStatus: response.status,
          ...(response.retryAfterMs === undefined ? {} : { retryAfterMs: response.retryAfterMs }),
        },
        { operation, readOnly: true },
      );
    if (!response.bytes) throw new QqApiError('invalid-response');
    return checked(decode(response.bytes), operation);
  }, options.timeoutMs ?? 25000);
};
