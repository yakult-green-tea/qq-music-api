import { QqApiError } from '../../protocol/errors';
import type { MusicuDescriptor } from '../../protocol/musicu';
import { type Dictionary, dictionaryOf, isDictionary, stringOf } from '../../util/values';
import type { AuthSession } from '../auth/qrLogin';
import { failureResult, type NewRouteResult, okResult } from './newRouteResult';
import { createSessionMusicuClient, type SessionMusicuOptions } from './sessionMusicu';

// src/services/recommend/songRelations.ts
//
// `/song/similar`、`/song/related-playlists`：一首歌的相似歌曲、包含它的歌单。Node 与 serverless 共用。
// 实测（2026-10）：两支都在 `music.recommend.TrackRelationServer`，参数是数字 `songid`。匿名时上游
// 回 code 0 但清单是空的（看起来像「没有」），所以两条都要登录。带会话时旧的 `vecSong`／`vecPlaylist`
// 也是空的，资料在 `vecSongNew[].songs[].track`（和 `track_info` 同形）与 `vecPlaylistNew[].playlists[]`。

/** 必填的歌曲 id：只认纯数字的正整数。 */
const songIdOf = (raw: unknown): number => {
  const text = String(raw ?? '');
  const value = /^\d{1,15}$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isSafeInteger(value) || value <= 0) throw new QqApiError('input');
  return value;
};

const countOf = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/** 上游把播放数写成字符串；只认纯数字（「12.5万」这种不给）。 */
const playCountOf = (value: unknown): number | undefined => {
  if (typeof value === 'number') return countOf(value);
  if (typeof value !== 'string' || !/^\d{1,15}$/.test(value)) return undefined;
  return countOf(Number(value));
};

/** 分组清单：null／缺省当作没有，其他非数组是格式变了。 */
const groupsOf = (data: unknown, key: string): unknown[] => {
  if (!isDictionary(data)) throw new QqApiError('invalid-response');
  const groups = data[key];
  if (groups !== null && groups !== undefined && !Array.isArray(groups))
    throw new QqApiError('invalid-response');
  return Array.isArray(groups) ? groups : [];
};

/** 把各组里的条目接成一个清单；某一组的条目不是数组就跳过那一组。 */
const rowsOf = (groups: unknown[], key: string): unknown[] =>
  groups.flatMap((group) => {
    const rows = dictionaryOf(group)[key];
    return Array.isArray(rows) ? rows : [];
  });

const similarSongs = (songid: number): MusicuDescriptor<unknown[]> => ({
  module: 'music.recommend.TrackRelationServer',
  method: 'GetSimilarSongs',
  param: { songid },
  readOnly: true,
  operation: 'song.similar',
  decode: (data) => rowsOf(groupsOf(data, 'vecSongNew'), 'songs'),
});

const relatedPlaylists = (songid: number): MusicuDescriptor<unknown[]> => ({
  module: 'music.recommend.TrackRelationServer',
  method: 'GetRelatedPlaylist',
  param: { songid, vecPlaylist: [] },
  readOnly: true,
  operation: 'song.related-playlists',
  decode: (data) => rowsOf(groupsOf(data, 'vecPlaylistNew'), 'playlists'),
});

/** `{ track }` 行里可以播的曲目（要有 mid）；`/recommend/autoplay` 也用这一份判断。 */
export const toTrack = (row: unknown): Dictionary | null => {
  const track = dictionaryOf(row).track;
  if (!isDictionary(track)) return null;
  return typeof track.mid === 'string' && track.mid.length > 0 ? track : null;
};

/** 摊平成推荐歌单的字段名（`tid`、`title`、`picurl`、`songnum`、`play_cnt`、`creator`）。 */
const toPlaylist = (row: unknown): Dictionary | null => {
  const item = dictionaryOf(row);
  const tid = item.tid;
  if (typeof tid !== 'number' || !Number.isSafeInteger(tid) || tid <= 0) return null;
  const songnum = countOf(item.songNum);
  const playCount = playCountOf(item.playCnt);
  const creator = stringOf(item.creator);
  return {
    tid,
    title: stringOf(item.title),
    picurl: stringOf(item.cover),
    ...(songnum === undefined ? {} : { songnum }),
    ...(playCount === undefined ? {} : { play_cnt: playCount }),
    creator: creator ? { nick: creator } : {},
  };
};

/** 没有会话回 401（匿名只会拿到空清单）；上游成功但没有条目回 422；有条目却一个都读不出来回 502。 */
const relationResult =
  <T>(
    phase: 'get-similar-songs' | 'get-related-playlists',
    descriptor: (songid: number) => MusicuDescriptor<unknown[]>,
    toItem: (row: unknown) => T | null,
    key: string,
  ) =>
  async (
    session: AuthSession | null,
    rawId: unknown,
    options: SessionMusicuOptions = {},
  ): Promise<NewRouteResult> => {
    try {
      if (!session) throw new QqApiError('auth-missing');
      const songid = songIdOf(rawId);
      const rows = await createSessionMusicuClient(session, options).execute(descriptor(songid));
      if (!rows.length) throw new QqApiError('not-found');
      const items = rows.map(toItem).filter((item) => item !== null);
      if (!items.length) throw new QqApiError('invalid-response');
      return okResult({ [key]: items });
    } catch (error) {
      return failureResult(phase, error);
    }
  };

export const similarSongsResult = relationResult(
  'get-similar-songs',
  similarSongs,
  toTrack,
  'songs',
);

export const relatedPlaylistsResult = relationResult(
  'get-related-playlists',
  relatedPlaylists,
  toPlaylist,
  'playlists',
);
