import { QqApiError } from '../../protocol/errors';
import { isDictionary } from '../../util/values';
import type { AuthSession } from '../auth/qrLogin';
import { failureResult, okResult } from './newRouteResult';
import { createSessionMusicuClient } from './sessionMusicu';

// src/services/recommend/listeningRank.ts
//
// `/user/listening-rank`：本人的听歌排行（ListenReportSvr/GetRank）。只读，不接 uin，
// 只能读自己的。type 1 日／2 周／3 月／4 年来自 App 抓包；周的边界（自然周或滚动七天）、
// token 的用途、有没有上限都还没有真账号证据，所以 date 与 token 都原样转交，不替上游解释。

const RANGE_TYPES = { day: 1, week: 2, month: 3, year: 4 } as const;
type Range = keyof typeof RANGE_TYPES;

const MAX_ITEMS = 500;
const MAX_TOKEN = 512;

const single = (value: string | string[] | undefined): string | undefined => {
  if (Array.isArray(value)) throw new QqApiError('input');
  return value;
};

// 日、周：YYYYMMDD；月：YYYYMM。只验是真实日期，周要不要落在周一交给上游，年没有样本所以不收。
const validDate = (range: Range, date: string): boolean => {
  if (range === 'day' || range === 'week') {
    if (!/^\d{8}$/.test(date)) return false;
    const [year, month, day] = [+date.slice(0, 4), +date.slice(4, 6), +date.slice(6, 8)];
    const parsed = new Date(Date.UTC(year, month - 1, day));
    return (
      parsed.getUTCFullYear() === year &&
      parsed.getUTCMonth() === month - 1 &&
      parsed.getUTCDate() === day
    );
  }
  if (range === 'month') return /^\d{4}(0[1-9]|1[0-2])$/.test(date);
  return false;
};

const inputOf = (query: {
  range: string | string[] | undefined;
  date: string | string[] | undefined;
  token: string | string[] | undefined;
  unsupported: boolean;
}) => {
  if (query.unsupported) throw new QqApiError('input');
  const range = single(query.range);
  if (!range || !Object.hasOwn(RANGE_TYPES, range)) throw new QqApiError('input');
  const date = single(query.date);
  if (date !== undefined && !validDate(range as Range, date)) throw new QqApiError('input');
  const token = single(query.token);
  if (token !== undefined && (!token || token.length > MAX_TOKEN || !/^[\x21-\x7e]+$/.test(token)))
    throw new QqApiError('input');
  return { range: range as Range, date, token };
};

const decode = (data: unknown) => {
  if (!isDictionary(data)) throw new QqApiError('invalid-response');
  const { rank, from, token } = data;
  // 没听过歌的时段，上游给 null；和空数组一样是正常的空榜。
  if (rank !== null && !Array.isArray(rank)) throw new QqApiError('invalid-response');
  if (from !== undefined && !Number.isSafeInteger(from)) throw new QqApiError('invalid-response');
  if (token !== undefined && typeof token !== 'string') throw new QqApiError('invalid-response');
  const list = Array.isArray(rank) ? rank : [];
  if (list.length > MAX_ITEMS) throw new QqApiError('invalid-response');
  const items = list.map((entry) => {
    if (!isDictionary(entry) || !isDictionary(entry.track))
      throw new QqApiError('invalid-response');
    const count = entry.listenCnt;
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0)
      throw new QqApiError('invalid-response');
    // 歌曲对象原样交出去，由前端自己正规化。
    return { track: entry.track, listenCount: count };
  });
  return {
    items,
    from: from as number | undefined,
    token: token as string | undefined,
  };
};

export const listeningRankResult = async (
  session: AuthSession | null,
  query: {
    range: string | string[] | undefined;
    date: string | string[] | undefined;
    token: string | string[] | undefined;
    unsupported: boolean;
  },
) => {
  try {
    if (!session) throw new QqApiError('auth-missing');
    const { range, date, token } = inputOf(query);
    const data = decode(
      await createSessionMusicuClient(session, { maxRetries: 0 }).execute({
        module: 'music.individuation.ListenReportSvr',
        method: 'GetRank',
        // 抓包的参数组：uin 为空串是本人；version 的必要性未知，照样带。
        param: {
          type: RANGE_TYPES[range],
          ...(date ? { date } : {}),
          uin: '',
          version: 'v2',
          token: token ?? '',
        },
        readOnly: true,
        operation: 'user.listening-rank',
      }),
    );
    return okResult({
      range,
      ...(date ? { date } : {}),
      ...(data.from !== undefined ? { from: data.from } : {}),
      ...(data.token ? { token: data.token } : {}),
      items: data.items,
    });
  } catch (error) {
    return failureResult('get-listening-rank', error);
  }
};
