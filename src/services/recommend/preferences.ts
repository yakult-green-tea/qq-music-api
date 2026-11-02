import type { UpstreamOperation } from '../../protocol/businessCodes';
import { CgiNetworkError, type CgiTransport } from '../../protocol/cgi';
import { normalizeQqFailure, QqApiError } from '../../protocol/errors';
import { withDeadline } from '../../protocol/http';
import { defaultTokenBucket } from '../../protocol/tokenBucket';
import { createFetchCgiTransport } from '../../transport/fetchCgi';
import { isDictionary } from '../../util/values';
import { type AuthSession, credentialCookieHeader } from '../auth/qrLogin';
import { failureResult, okResult } from './newRouteResult';

// 私人 FM 与每日30首共用的音乐偏好：读官方偏好页首屏数据里的当前分值。
// 只找唯一一处明确的 JSON 赋值，有界地截取、解析，不执行页面脚本，也不回传页面里的歌曲。
const PAGE_URL = 'https://i.y.qq.com/n2/m/client/preferences_set_v2/index.html';
// 2026-11 实测可用的移动端页面 UA；只影响页面版本，不带设备或账号信息。
const PAGE_USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 QQMusic/14.0';
const OPERATION: UpstreamOperation = 'recommend.preferences';
const MAX_PAGE_BYTES = 1024 * 1024;
const MAX_DATA_CHARS = 512 * 1024;
const MAX_PROFILES = 32;
const MARKER = /__ssrFirstPageData__\s*=\s*\{/g;

const firstPageData = (html: string): unknown => {
  const found = [...html.matchAll(MARKER)];
  if (found.length !== 1 || found[0].index === undefined) throw new QqApiError('invalid-response');
  const start = found[0].index + found[0][0].length - 1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < html.length && i - start < MAX_DATA_CHARS; i++) {
    const char = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}' && --depth === 0) {
      try {
        return JSON.parse(html.slice(start, i + 1));
      } catch {
        throw new QqApiError('invalid-response');
      }
    }
  }
  throw new QqApiError('invalid-response');
};

const readPage = (session: AuthSession, http: CgiTransport) =>
  withDeadline(async (signal) => {
    await defaultTokenBucket.acquire(signal);
    let response: Awaited<ReturnType<CgiTransport>>;
    try {
      response = await http({
        url: PAGE_URL,
        headers: {
          Cookie: credentialCookieHeader(session.credential),
          'User-Agent': PAGE_USER_AGENT,
        },
        signal,
      });
    } catch (error) {
      if (error instanceof QqApiError) throw error;
      const observed =
        error instanceof CgiNetworkError ? { name: error.nativeName, code: error.code } : error;
      throw normalizeQqFailure(
        { source: 'network', error: observed },
        { operation: OPERATION, readOnly: true },
      );
    }
    // 转址多半是登录页或验证页，不跟随，也不当成会话失效。
    if (response.status >= 300 && response.status < 400)
      throw new QqApiError('upstream-http', { upstreamHttpStatus: response.status });
    if (response.status < 200 || response.status >= 300)
      throw normalizeQqFailure(
        {
          source: 'http',
          upstreamHttpStatus: response.status,
          ...(response.retryAfterMs === undefined ? {} : { retryAfterMs: response.retryAfterMs }),
        },
        { operation: OPERATION, readOnly: true },
      );
    if (!response.bytes || response.bytes.byteLength > MAX_PAGE_BYTES)
      throw new QqApiError('invalid-response');
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(response.bytes);
    } catch {
      throw new QqApiError('invalid-response');
    }
  }, 25000);

export const recommendationPreferencesResult = async (
  session: AuthSession | null,
  unsupportedQuery: boolean,
  http: CgiTransport = createFetchCgiTransport(),
) => {
  try {
    if (!session) throw new QqApiError('auth-missing');
    if (unsupportedQuery) throw new QqApiError('input');
    const page = firstPageData(await readPage(session, http));
    if (!isDictionary(page) || !Number.isSafeInteger(page.code))
      throw new QqApiError('invalid-response');
    if (page.code !== 0)
      throw normalizeQqFailure(
        { source: 'business', upstreamCode: page.code as number },
        { operation: OPERATION },
      );
    const data = page.data;
    if (!isDictionary(data) || !Array.isArray(data.ProfileScore))
      throw new QqApiError('invalid-response');
    if (data.ProfileScore.length > MAX_PROFILES) throw new QqApiError('invalid-response');
    const seen = new Set<string>();
    const profiles = data.ProfileScore.map((entry: unknown) => {
      if (
        !isDictionary(entry) ||
        typeof entry.ProfileKey !== 'string' ||
        !/^\d{1,12}$/.test(entry.ProfileKey) ||
        seen.has(entry.ProfileKey) ||
        typeof entry.ProfileName !== 'string' ||
        !Number.isSafeInteger(entry.CurrentScore) ||
        (entry.CurrentScore as number) < 0 ||
        (entry.CurrentScore as number) > 100
      )
        throw new QqApiError('invalid-response');
      seen.add(entry.ProfileKey);
      // 目标分值、是否可调、是否屏蔽和更新时间的含义未确认，不对外返回。
      return { key: entry.ProfileKey, name: entry.ProfileName, score: entry.CurrentScore };
    });
    if (!profiles.length) throw new QqApiError('not-found');
    return okResult({ scope: 'account', profiles });
  } catch (error) {
    return failureResult('get-recommendation-preferences', error);
  }
};
