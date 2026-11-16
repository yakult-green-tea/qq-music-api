import { normalizeQqFailure, QqApiError } from '../../protocol/errors';
import type { MusicuDescriptor } from '../../protocol/musicu';
import { type Dictionary, dictionaryOf, isDictionary } from '../../util/values';
import type { AuthSession } from '../auth/qrLogin';
import { failureResult, type NewRouteResult, okResult } from '../recommend/newRouteResult';
import { createSessionMusicuClient, type SessionMusicuOptions } from '../recommend/sessionMusicu';

// src/services/user/favoriteMvs.ts
//
// `/user/mvs`：本人收藏的 MV。Node 与 serverless 共用。
// 实测（2026-11，带会话）：官方 App 用 `music.musicasset.MVFavRead.getMyFavMV`
// `{ uin: 加密 uin, req_icon_type: 1, support: 1 }`，没有分页参数，回
// `{ code, subcode, msg, hasmore, total, mvlist }`。同一个账号 `getMyFavMV_v2` 少回一笔，所以只用 v1。
// `more` 照上游 `hasmore`，本接口没有下一页可读；上传者的加密 uin 和昵称不交出。

export interface FavoriteMvSinger {
  id: number;
  mid: string;
  name: string;
}

const stringOf = (value: unknown): string => (typeof value === 'string' ? value : '');
const countOf = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/** `page` 只能省略或是 1：上游没有分页参数。 */
const checkPage = (raw: unknown): void => {
  if (raw !== undefined && raw !== '1') throw new QqApiError('input');
};

const singersOf = (value: unknown): FavoriteMvSinger[] =>
  (Array.isArray(value) ? value : []).flatMap((item) => {
    const singer = dictionaryOf(item);
    const id = countOf(singer.id);
    return id ? [{ id, mid: stringOf(singer.mid), name: stringOf(singer.name) }] : [];
  });

const toMv = (row: unknown): Dictionary | null => {
  if (!isDictionary(row)) return null;
  const vid = stringOf(row.vid);
  if (!vid) return null;
  const optional: Dictionary = {};
  for (const [key, value] of [
    ['duration', countOf(row.duration)],
    ['playCount', countOf(row.playcount)],
    ['publishDate', countOf(row.publish_date)],
    ['time', countOf(row.time)],
  ] as const)
    if (value !== undefined) optional[key] = value;
  return {
    vid,
    mid: stringOf(row.mid),
    name: stringOf(row.mv_name),
    cover: stringOf(row.mv_picurl),
    ...optional,
    singers: singersOf(row.singer),
  };
};

const decodeDictionary = (data: unknown): Dictionary => {
  if (!isDictionary(data)) throw new QqApiError('invalid-response');
  return data;
};

const favoriteMvs = (encryptedUin: string): MusicuDescriptor<Dictionary> => ({
  module: 'music.musicasset.MVFavRead',
  method: 'getMyFavMV',
  param: { uin: encryptedUin, req_icon_type: 1, support: 1 },
  readOnly: true,
  operation: 'user.favorite-mvs',
  decode: decodeDictionary,
});

/** data 里的 code／subcode 非零是上游拒绝（要在 decode 之后检查，decode 丢的错一律算格式错误）。 */
const innerCodeOf = (data: Dictionary): void => {
  for (const key of ['code', 'subcode']) {
    const value = data[key];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isSafeInteger(value))
      throw new QqApiError('invalid-response');
    if (value !== 0) throw normalizeQqFailure({ source: 'business', upstreamCode: value });
  }
};

/** 没有收藏回 200 空数组；有条目却一笔都读不出来回 502，不当成「没有」。 */
export const favoriteMvsResult = async (
  session: AuthSession | null,
  rawPage: unknown,
  options: SessionMusicuOptions = {},
): Promise<NewRouteResult> => {
  try {
    if (!session) throw new QqApiError('auth-missing');
    checkPage(rawPage);
    const encryptedUin = session.credential.encryptUin;
    if (typeof encryptedUin !== 'string' || !encryptedUin) throw new QqApiError('unexpected');
    const data = await createSessionMusicuClient(session, options).execute(
      favoriteMvs(encryptedUin),
    );
    innerCodeOf(data);
    const list = data.mvlist;
    if (list !== null && list !== undefined && !Array.isArray(list))
      throw new QqApiError('invalid-response');
    const rows = Array.isArray(list) ? list : [];
    const mvs = rows.map(toMv).filter((item) => item !== null);
    if (rows.length && !mvs.length) throw new QqApiError('invalid-response');
    return okResult({ mvs, total: countOf(data.total) ?? null, more: data.hasmore === 1 });
  } catch (error) {
    return failureResult('get-favorite-mvs', error);
  }
};
