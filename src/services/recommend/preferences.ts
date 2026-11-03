import type { UpstreamOperation } from '../../protocol/businessCodes';
import { CgiNetworkError, type CgiTransport } from '../../protocol/cgi';
import { normalizeQqFailure, QqApiError } from '../../protocol/errors';
import { withDeadline } from '../../protocol/http';
import { defaultTokenBucket } from '../../protocol/tokenBucket';
import { createFetchCgiTransport } from '../../transport/fetchCgi';
import { dictionaryOf, isDictionary } from '../../util/values';
import { type AuthSession, credentialCookieHeader } from '../auth/qrLogin';
import { exactObjectOf } from '../user/writeInput';
import { failureResult, type NewRouteResult, okResult } from './newRouteResult';
import { createSessionMusicuClient } from './sessionMusicu';

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
const KEY = /^\d{1,12}$/;
const isScore = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 100;
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
        maxBytes: MAX_PAGE_BYTES,
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

interface Profile {
  key: string;
  name: string;
  score: number;
  /** 页面上这一项的 IsBlack；只在写入时原样带回，不对外返回，含义未确认。 */
  black?: boolean;
}

const readProfiles = async (session: AuthSession, http: CgiTransport): Promise<Profile[]> => {
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
  return data.ProfileScore.map((entry: unknown) => {
    if (
      !isDictionary(entry) ||
      typeof entry.ProfileKey !== 'string' ||
      !KEY.test(entry.ProfileKey) ||
      seen.has(entry.ProfileKey) ||
      typeof entry.ProfileName !== 'string' ||
      !isScore(entry.CurrentScore)
    )
      throw new QqApiError('invalid-response');
    seen.add(entry.ProfileKey);
    // 目标分值、是否可调、是否屏蔽和更新时间的含义未确认，不对外返回。屏蔽旗标留着给写入原样带回。
    return {
      key: entry.ProfileKey,
      name: entry.ProfileName,
      score: entry.CurrentScore,
      ...(typeof entry.IsBlack === 'boolean' ? { black: entry.IsBlack } : {}),
    };
  });
};

export const recommendationPreferencesResult = async (
  session: AuthSession | null,
  unsupportedQuery: boolean,
  http: CgiTransport = createFetchCgiTransport(),
) => {
  try {
    if (!session) throw new QqApiError('auth-missing');
    if (unsupportedQuery) throw new QqApiError('input');
    const profiles = await readProfiles(session, http);
    if (!profiles.length) throw new QqApiError('not-found');
    return okResult({ scope: 'account', profiles: profiles.map(publicOf) });
  } catch (error) {
    return failureResult('get-recommendation-preferences', error);
  }
};

const publicOf = ({ key, name, score }: Profile) => ({ key, name, score });

/**
 * 同一个进程里，同一账号的「读现值、整份写、读回」排成一队：两次修改不同项的请求并发时，后一次不会拿着旧的
 * 整份覆盖前一次。Serverless 各个实例、手机官方 App 同时改，这里管不到。
 */
const accountQueues = new Map<string, Promise<unknown>>();
const inAccountQueue = <T>(account: string, task: () => Promise<T>): Promise<T> => {
  const before = accountQueues.get(account) ?? Promise.resolve();
  const run = before.then(task, task);
  const tail = run.catch(() => undefined);
  accountQueues.set(account, tail);
  void tail.then(() => {
    if (accountQueues.get(account) === tail) accountQueues.delete(account);
  });
  return run;
};

const updatesOf = (raw: unknown): Map<string, number> => {
  const input = exactObjectOf(raw, ['profiles']);
  if (
    !Array.isArray(input.profiles) ||
    !input.profiles.length ||
    input.profiles.length > MAX_PROFILES
  )
    throw new QqApiError('input');
  const updates = new Map<string, number>();
  for (const value of input.profiles) {
    const item = exactObjectOf(value, ['key', 'score']);
    if (
      typeof item.key !== 'string' ||
      !KEY.test(item.key) ||
      updates.has(item.key) ||
      !isScore(item.score)
    )
      throw new QqApiError('input');
    updates.set(item.key, item.score);
  }
  return updates;
};

/**
 * 手机每次都把整份偏好写一次；这里先读现值，只换指定项，写一次后再读偏好页确认。官方页面的 IsSetBlack 按
 * 每项原来的屏蔽旗标送，这里照样带回，不替用户解除屏蔽；页面没给这个旗标就不写。IsAdjust 照手机样本送 0。
 * 读回时目标项和其余项（分值、屏蔽旗标）都要和预期一致才算确认。写入不重试；结果不明时标出已尝试。
 */
export const recommendationPreferencesUpdateResult = async (
  session: AuthSession | null,
  raw: unknown,
  http: CgiTransport = createFetchCgiTransport(),
): Promise<NewRouteResult> => {
  const state = { attempted: false, accepted: false };
  try {
    if (!session) throw new QqApiError('auth-missing');
    const updates = updatesOf(raw);
    return await inAccountQueue(String(session.credential.musicid), async () => {
      const current = await readProfiles(session, http);
      if ([...updates.keys()].some((key) => !current.some((item) => item.key === key)))
        throw new QqApiError('input');
      const matches = (profiles: Profile[]) =>
        [...updates].every(([key, score]) =>
          profiles.some((item) => item.key === key && item.score === score),
        );
      if (matches(current))
        return okResult({
          scope: 'account',
          writeAttempted: false,
          verified: true,
          verification: 'confirmed',
          profiles: current.map(publicOf),
        });
      // 没有屏蔽旗标就重建不出整份原样，宁可不写，也不替用户改掉没选的项。
      if (current.some((item) => item.black === undefined))
        throw new QqApiError('invalid-response');
      // 写入后的整份应有的样子：目标项换新分值，其余项和屏蔽旗标都不变。
      const expected = current.map((item) => ({
        ...item,
        score: updates.get(item.key) ?? item.score,
      }));
      const unchanged = (profiles: Profile[]) =>
        profiles.length === expected.length &&
        expected.every((want) =>
          profiles.some(
            (item) =>
              item.key === want.key && item.score === want.score && item.black === want.black,
          ),
        );
      state.attempted = true;
      const data = await createSessionMusicuClient(session, { maxRetries: 0 }).execute({
        module: 'music.recommend.UserProfileSettingSvr',
        method: 'SetUserProfile',
        param: {
          Profiles: expected.map((item) => ({
            Score: item.score,
            ProfileKey: item.key,
            IsAdjust: 0,
            IsSetBlack: item.black ? 1 : 0,
          })),
        },
        readOnly: false,
        operation: 'recommend.preferences-write',
      });
      // 回包只有 Msg，没有可泛化的功能码；成败以读回为准。
      if (!isDictionary(data)) throw new QqApiError('invalid-response');
      state.accepted = true;
      const after = await readProfiles(session, http);
      const verified = unchanged(after);
      return okResult({
        scope: 'account',
        accepted: true,
        writeAttempted: true,
        verified,
        verification: verified ? 'confirmed' : 'unconfirmed',
        profiles: after.map(publicOf),
      });
    });
  } catch (error) {
    const result = failureResult('recommendation-preferences-write', error);
    return state.attempted
      ? {
          ...result,
          body: {
            ...dictionaryOf(result.body),
            retryable: false,
            writeAttempted: true,
            accepted: state.accepted,
            verified: false,
            verification: 'unconfirmed',
          },
        }
      : result;
  }
};
