import { QqApiError } from '../../protocol/errors';
import type { MusicuDescriptor } from '../../protocol/musicu';
import { dictionaryOf, isDictionary } from '../../util/values';
import type { AuthSession } from '../auth/qrLogin';
import { failureResult, type NewRouteResult, okResult } from '../recommend/newRouteResult';
import { createSessionMusicuClient, type SessionMusicuOptions } from '../recommend/sessionMusicu';

// src/services/song/genre.ts
//
// `/song/genre`：一首歌的流派。Node 与 serverless 共用。
// 实测（2026-11，带会话）：`music.recommend.TrackRelationServer.GetSongGenre { songid }` 回
// `{ genres: [{ id, name, scheme, from_type, lp_url }], abt }`，很多歌没有流派，`genres` 是空数组。
// 流派和歌曲标签（`GetSongLabels`）、歌曲详情里的 `genre` 数字不是一回事，不互相换算。
// 只交 id 和 name；落地页网址、来源旗标不交。

export interface SongGenre {
  id: number;
  name: string;
}

/** 必填的歌曲 id：只认纯数字的正整数，和 `/song/similar` 一样。 */
const songIdOf = (raw: unknown): number => {
  const text = typeof raw === 'string' ? raw : '';
  const value = /^\d{1,15}$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isSafeInteger(value) || value <= 0) throw new QqApiError('input');
  return value;
};

/** null／缺省是没有流派；其他非数组是格式变了。 */
const genreRowsOf = (data: unknown): unknown[] => {
  if (!isDictionary(data)) throw new QqApiError('invalid-response');
  const rows = data.genres;
  if (rows === null || rows === undefined) return [];
  if (!Array.isArray(rows)) throw new QqApiError('invalid-response');
  return rows;
};

const toGenre = (row: unknown): SongGenre | null => {
  const item = dictionaryOf(row);
  const { id, name } = item;
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) return null;
  if (typeof name !== 'string' || !name) return null;
  return { id, name };
};

const songGenre = (songid: number): MusicuDescriptor<unknown[]> => ({
  module: 'music.recommend.TrackRelationServer',
  method: 'GetSongGenre',
  param: { songid },
  readOnly: true,
  operation: 'song.genre',
  decode: genreRowsOf,
});

/** 没有流派回 200 空数组；有条目却一个都读不出来回 502，不当成「没有」。 */
export const songGenreResult = async (
  session: AuthSession | null,
  rawId: unknown,
  options: SessionMusicuOptions = {},
): Promise<NewRouteResult> => {
  try {
    if (!session) throw new QqApiError('auth-missing');
    const songid = songIdOf(rawId);
    const rows = await createSessionMusicuClient(session, options).execute(songGenre(songid));
    const genres = rows.map(toGenre).filter((item) => item !== null);
    if (rows.length && !genres.length) throw new QqApiError('invalid-response');
    return okResult({ genres });
  } catch (error) {
    return failureResult('get-song-genre', error);
  }
};
