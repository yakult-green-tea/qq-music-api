import { QqApiError } from '../../protocol/errors';
import type { MusicuDescriptor } from '../../protocol/musicu';
import { type Dictionary, dictionaryOf, isDictionary } from '../../util/values';
import type { AuthSession } from '../auth/qrLogin';
import { failureResult, type NewRouteResult, okResult } from '../recommend/newRouteResult';
import { createSessionMusicuClient, type SessionMusicuOptions } from '../recommend/sessionMusicu';

// src/services/user/singerRank.ts
//
// `/user/singer-rank`：本人的歌手榜。Node 与 serverless 共用。
// 实测（2026-11，带会话）：`music.recommend.UserProfileSettingSvr.GetProfileReportDetail { VisitAccount, ShowType }`，
// 官方 App 的「年／总／月／去年」对应 ShowType 23／25／26／24。官方 App 除了「去年」都多带一个歌手 Id，
// 实测四种都不带 Id 也各回 30 位歌手，所以这里不带。只读本人（VisitAccount 用自己的加密 uin）；
// 年龄、流派、BPM 等其他区块不交出。

const RANGES = { year: 23, all: 25, month: 26, 'last-year': 24 } as const;
type Range = keyof typeof RANGES;

const rangeOf = (raw: unknown): Range => {
  if (typeof raw !== 'string' || !Object.hasOwn(RANGES, raw)) throw new QqApiError('input');
  return raw as Range;
};

const countOf = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const integerOf = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
const stringOf = (value: unknown): string => (typeof value === 'string' ? value : '');

const report = (encryptedUin: string, range: Range): MusicuDescriptor<Dictionary> => ({
  module: 'music.recommend.UserProfileSettingSvr',
  method: 'GetProfileReportDetail',
  param: { VisitAccount: encryptedUin, ShowType: RANGES[range] },
  readOnly: true,
  operation: 'user.singer-rank',
  decode: (data) => {
    if (!isDictionary(data)) throw new QqApiError('invalid-response');
    return data;
  },
});

/** 名次变化可以是负数；占比照原样给数值。读不出来的数字省略。 */
const toSinger = (row: unknown): Dictionary | null => {
  const item = dictionaryOf(row);
  const mid = stringOf(item.Mid);
  if (!mid) return null;
  const ext = dictionaryOf(Array.isArray(item.SingerInfoExt) ? item.SingerInfoExt[0] : undefined);
  const rank = countOf(item.Ranking);
  const optional: Array<[string, number | undefined]> = [
    ['rank', rank ? rank : undefined],
    ['change', integerOf(item.ChangeRanking)],
    ['playCount', countOf(item.Num)],
    [
      'share',
      typeof ext.ProportionOf === 'number' && Number.isFinite(ext.ProportionOf)
        ? ext.ProportionOf
        : undefined,
    ],
  ];
  return {
    mid,
    name: stringOf(item.Title),
    avatar: stringOf(item.ImgUrl),
    ...Object.fromEntries(optional.filter(([, value]) => value !== undefined)),
  };
};

/** 还没有歌手回 200 空数组；没有歌手区块或有条目却读不出来回 502。 */
export const singerRankResult = async (
  session: AuthSession | null,
  rawRange: unknown,
  options: SessionMusicuOptions = {},
): Promise<NewRouteResult> => {
  try {
    if (!session) throw new QqApiError('auth-missing');
    const range = rangeOf(rawRange);
    const encryptedUin = session.credential.encryptUin;
    if (typeof encryptedUin !== 'string' || !encryptedUin) throw new QqApiError('unexpected');
    const data = await createSessionMusicuClient(session, options).execute(
      report(encryptedUin, range),
    );
    if (!isDictionary(data.Singer)) throw new QqApiError('invalid-response');
    const list = data.Singer.Singers;
    if (list !== null && list !== undefined && !Array.isArray(list))
      throw new QqApiError('invalid-response');
    const rows = Array.isArray(list) ? list : [];
    const singers = rows.map(toSinger).filter((item) => item !== null);
    if (rows.length && !singers.length) throw new QqApiError('invalid-response');
    return okResult({ range, singers });
  } catch (error) {
    return failureResult('get-singer-rank', error);
  }
};
