import { normalizeQqFailure, QqApiError } from '../../protocol/errors';
import type { MusicuDescriptor } from '../../protocol/musicu';
import { type Dictionary, dictionaryOf, isDictionary } from '../../util/values';
import type { AuthSession } from '../auth/qrLogin';
import { failureResult, type NewRouteResult, okResult } from '../recommend/newRouteResult';
import { createSessionMusicuClient, type SessionMusicuOptions } from '../recommend/sessionMusicu';
import { toTrack } from '../recommend/songRelations';

// src/services/user/recentPlays.ts
//
// `/user/recent-plays`：云端最近播放，只读，不上报。Node 与 serverless 共用。
// 实测（2026-11，带会话）：`music.musicasset.PlayRecentlyRead.GetPlayRecentlyInfo { type, updateTime: 0 }`
// 每个 type 都回同一个外壳 `{ type, data: { allItems, songList, albumList, geDanList, radioList, mvList, ... },
// updateTime, code }`，只有对应那一类有内容。官方页面分页对照：2 歌曲、3 专辑、4 歌单、5 音乐雷达、6 视频。
// 「全部」（1）、有声节目（12）和开页时顺带请求的 10、14 不开放。上游没有分页，`total` 只算这次返回的条数。
// 最近播放的设备、歌单创建者账号、MV 付费资料不交出。

type RecentType = 'song' | 'album' | 'playlist' | 'radio' | 'mv';

const TYPES: Record<
  RecentType,
  { code: number; list: string; toItem: (row: unknown) => Dictionary | null }
> = {
  song: { code: 2, list: 'songList', toItem: (row) => songOf(row) },
  album: { code: 3, list: 'albumList', toItem: (row) => albumOf(row) },
  playlist: { code: 4, list: 'geDanList', toItem: (row) => playlistOf(row) },
  radio: { code: 5, list: 'radioList', toItem: (row) => radioOf(row) },
  mv: { code: 6, list: 'mvList', toItem: (row) => mvOf(row) },
};

const stringOf = (value: unknown): string => (typeof value === 'string' ? value : '');
const countOf = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const positiveOf = (value: unknown): number | undefined => {
  const count = countOf(value);
  return count ? count : undefined;
};
/** 只放读得出来的数字字段；`lastTime` 保留上游数值，不推断单位。 */
const numbers = (pairs: [string, number | undefined][]): Dictionary =>
  Object.fromEntries(pairs.filter(([, value]) => value !== undefined));

const songOf = (row: unknown): Dictionary | null => {
  const song = toTrack(row);
  if (!song) return null;
  const item = dictionaryOf(row);
  return {
    song,
    ...numbers([
      ['lastTime', countOf(item.lastTime)],
      ['listenCount', countOf(item.listenCnt)],
    ]),
  };
};

const albumOf = (row: unknown): Dictionary | null => {
  const item = dictionaryOf(row);
  const id = positiveOf(item.id);
  const mid = stringOf(item.mid);
  if (!id && !mid) return null;
  return {
    ...numbers([['id', id]]),
    mid,
    name: stringOf(item.name),
    singerName: stringOf(item.singerName),
    ...numbers([['lastTime', countOf(item.lastTime)]]),
  };
};

const playlistOf = (row: unknown): Dictionary | null => {
  const item = dictionaryOf(row);
  const id = positiveOf(item.id);
  if (!id) return null;
  return {
    id,
    ...numbers([['dirId', countOf(item.dirId)]]),
    name: stringOf(item.name),
    cover: stringOf(item.pic),
    creator: stringOf(item.creater),
    ...numbers([
      ['songCount', countOf(item.num)],
      ['lastTime', countOf(item.lastTime)],
    ]),
  };
};

const radioOf = (row: unknown): Dictionary | null => {
  const item = dictionaryOf(row);
  const id = positiveOf(item.id);
  if (!id) return null;
  return {
    id,
    name: stringOf(item.name),
    cover: stringOf(item.pic),
    ...numbers([
      ['radioType', countOf(item.radioType)],
      ['lastTime', countOf(item.lastTime)],
    ]),
  };
};

const mvOf = (row: unknown): Dictionary | null => {
  const item = dictionaryOf(row);
  const info = dictionaryOf(item.mvInfo);
  const vid = stringOf(info.vid);
  if (!vid) return null;
  const singers = (Array.isArray(info.singers) ? info.singers : []).flatMap((value) => {
    const singer = dictionaryOf(value);
    const id = positiveOf(singer.id);
    return id ? [{ id, mid: stringOf(singer.mid), name: stringOf(singer.name) }] : [];
  });
  return {
    vid,
    name: stringOf(info.name),
    cover: stringOf(info.cover_pic),
    singers,
    ...numbers([['lastTime', countOf(item.lastTime)]]),
  };
};

const typeOf = (raw: unknown): RecentType => {
  if (raw === undefined) return 'song';
  if (typeof raw !== 'string' || !Object.hasOwn(TYPES, raw)) throw new QqApiError('input');
  return raw as RecentType;
};

const decodeDictionary = (data: unknown): Dictionary => {
  if (!isDictionary(data)) throw new QqApiError('invalid-response');
  return data;
};

const recentPlays = (code: number): MusicuDescriptor<Dictionary> => ({
  module: 'music.musicasset.PlayRecentlyRead',
  method: 'GetPlayRecentlyInfo',
  param: { type: code, updateTime: 0 },
  readOnly: true,
  operation: 'user.recent-plays',
  decode: decodeDictionary,
});

/** data 里的 code 非零是上游拒绝（decode 之后检查：decode 丢的错一律算格式错误）。 */
const rowsOf = (data: Dictionary, list: string): unknown[] => {
  const { code } = data;
  if (code !== undefined) {
    if (typeof code !== 'number' || !Number.isSafeInteger(code))
      throw new QqApiError('invalid-response');
    if (code !== 0) throw normalizeQqFailure({ source: 'business', upstreamCode: code });
  }
  if (!isDictionary(data.data)) throw new QqApiError('invalid-response');
  const rows = data.data[list];
  if (rows === null || rows === undefined) return [];
  if (!Array.isArray(rows)) throw new QqApiError('invalid-response');
  return rows;
};

/** 没播过回 200 空数组；有条目却一条都读不出来回 502，不当成「没有」。 */
export const recentPlaysResult = async (
  session: AuthSession | null,
  rawType: unknown,
  options: SessionMusicuOptions = {},
): Promise<NewRouteResult> => {
  try {
    if (!session) throw new QqApiError('auth-missing');
    const type = typeOf(rawType);
    const spec = TYPES[type];
    const data = await createSessionMusicuClient(session, options).execute(recentPlays(spec.code));
    const rows = rowsOf(data, spec.list);
    const items = rows.map(spec.toItem).filter((item) => item !== null);
    if (rows.length && !items.length) throw new QqApiError('invalid-response');
    return okResult({ type, items, total: items.length });
  } catch (error) {
    return failureResult('get-recent-plays', error);
  }
};
