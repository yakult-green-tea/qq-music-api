import { QqApiError } from '../../protocol/errors';
import type { MusicuDescriptor } from '../../protocol/musicu';
import { type Dictionary, dictionaryOf, isDictionary } from '../../util/values';
import type { AuthSession } from '../auth/qrLogin';
import { RANGE_TYPES, type Range, validDate } from './listeningRank';
import { failureResult, type NewRouteResult, okResult } from './newRouteResult';
import { createSessionMusicuClient, type SessionMusicuOptions } from './sessionMusicu';

// src/services/recommend/listeningReport.ts
//
// `/user/listening-report`：本人的听歌报告（`ListenReportSvr.GetBar`），和 `/user/listening-rank`（GetRank，
// 歌曲排行）是同一个服务的两个接口，分开提供。只读本人。
// 实测（2026-11，带会话）：参数 `{ type 1–4, date?, optionType: 1, token: '', uin: '', version: 'v2' }`；
// 年报告的 date 是 YYYY，其余规则和听歌排行相同。`listenTime.listenTimeSec` 当天的值等于好友日榜和音乐力的
// 当天秒数。`percent`、`upOrDown` 对不上两周秒数的变化或比例，意义不明，不交出；本人资料、token、文字区块也不交出。

const rangeOf = (raw: unknown): Range => {
  if (typeof raw !== 'string' || !Object.hasOwn(RANGE_TYPES, raw)) throw new QqApiError('input');
  return raw as Range;
};

/** 日、周、月同听歌排行；年收 YYYY。 */
const dateOf = (range: Range, raw: unknown): string | undefined => {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') throw new QqApiError('input');
  const valid = range === 'year' ? /^\d{4}$/.test(raw) : validDate(range, raw);
  if (!valid) throw new QqApiError('input');
  return raw;
};

const countOf = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const stringOf = (value: unknown): string => (typeof value === 'string' ? value : '');
const numbers = (pairs: Array<[string, number | undefined]>): Dictionary =>
  Object.fromEntries(pairs.filter(([, value]) => value !== undefined));

const report = (range: Range, date: string | undefined): MusicuDescriptor<Dictionary> => ({
  module: 'music.individuation.ListenReportSvr',
  method: 'GetBar',
  param: {
    type: RANGE_TYPES[range],
    ...(date === undefined ? {} : { date }),
    optionType: 1,
    token: '',
    uin: '',
    version: 'v2',
  },
  readOnly: true,
  operation: 'user.listening-report',
  decode: (data) => {
    if (!isDictionary(data)) throw new QqApiError('invalid-response');
    return data;
  },
});

const toChartItem = (row: unknown): Dictionary | null => {
  const item = dictionaryOf(row);
  const id = countOf(item.id);
  if (!id) return null;
  return {
    id,
    name: stringOf(item.name),
    ...numbers([
      ['value', countOf(item.value)],
      ['rank', countOf(item.rank)],
    ]),
  };
};

/** 图表按时段排序；时段不是对象、某个时段不是数组都算格式变了。 */
const chartOf = (bar: unknown): Dictionary[] => {
  const results = dictionaryOf(bar).optionResults;
  if (results === null || results === undefined) return [];
  if (!isDictionary(results)) throw new QqApiError('invalid-response');
  return Object.keys(results)
    .sort()
    .map((period) => {
      const rows = results[period];
      if (rows === null) return { period, items: [] };
      if (!Array.isArray(rows)) throw new QqApiError('invalid-response');
      return { period, items: rows.map(toChartItem).filter((item) => item !== null) };
    });
};

const toHighlight = (row: unknown): Dictionary | null => {
  if (!isDictionary(row)) return null;
  const title = stringOf(row.title);
  if (!title) return null;
  return {
    ...numbers([['type', countOf(row.type)]]),
    title,
    subtitle: stringOf(row.subtitle),
    ...numbers([['value', countOf(row.value)]]),
  };
};

export const listeningReportResult = async (
  session: AuthSession | null,
  query: { range: unknown; date: unknown },
  options: SessionMusicuOptions = {},
): Promise<NewRouteResult> => {
  try {
    if (!session) throw new QqApiError('auth-missing');
    const range = rangeOf(query.range);
    const date = dateOf(range, query.date);
    const data = await createSessionMusicuClient(session, options).execute(report(range, date));
    for (const key of ['listenTime', 'bar']) {
      if (data[key] != null && !isDictionary(data[key])) throw new QqApiError('invalid-response');
    }
    for (const key of ['highLights', 'availableDates']) {
      if (data[key] != null && !Array.isArray(data[key])) throw new QqApiError('invalid-response');
    }
    const listenTime = dictionaryOf(data.listenTime);
    return okResult({
      range,
      ...(date === undefined ? {} : { date }),
      availableDates: (Array.isArray(data.availableDates) ? data.availableDates : []).filter(
        (value): value is string => typeof value === 'string' && value.length > 0,
      ),
      ...numbers([
        ['listenSeconds', countOf(listenTime.listenTimeSec)],
        ['listenCount', countOf(listenTime.listenCnt)],
        ['activeHour', countOf(listenTime.activeHour)],
      ]),
      chart: chartOf(data.bar),
      highlights: (Array.isArray(data.highLights) ? data.highLights : [])
        .map(toHighlight)
        .filter((item) => item !== null),
    });
  } catch (error) {
    return failureResult('get-listening-report', error);
  }
};
