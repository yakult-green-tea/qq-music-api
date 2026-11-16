import { normalizeQqFailure, QqApiError } from '../../protocol/errors';
import type { MusicuDescriptor } from '../../protocol/musicu';
import { type Dictionary, isDictionary } from '../../util/values';
import type { AuthSession } from '../auth/qrLogin';
import { songIdOf } from '../song/readValues';
import { failureResult, type NewRouteResult, okResult } from './newRouteResult';
import { createSessionMusicuClient, type SessionMusicuOptions } from './sessionMusicu';
import { toTrack } from './songRelations';

// src/services/recommend/autoplay.ts
//
// `/recommend/autoplay`：放完一首后接着放什么。Node 与 serverless 共用。
// 实测（2026-11，带会话）：`music.recommend.AutoPlayServer.GetAutoPlayList { vecSong, amount, from: 8 }`
// 回 `{ retcode, msg, vecSong: [{ track }] }`；官方 App 种子 1～5 首、amount 通常等于种子数，
// 两个账号给 1 首种子都回 50 首，amount 看起来不限制数量。和 `/song/similar` 是不同的上游，用途也不同。
// `limit` 只在本地截短，不改送给上游的参数，也不改顺序。

const MAX_SEEDS = 5;
const MAX_LIMIT = 50;

const seedsOf = (raw: unknown): number[] => {
  if (typeof raw !== 'string' || !raw) throw new QqApiError('input');
  const parts = raw.split(',');
  if (parts.length > MAX_SEEDS) throw new QqApiError('input');
  const ids = parts.map(songIdOf);
  if (new Set(ids).size !== ids.length) throw new QqApiError('input');
  return ids;
};

/** 可选的本地截短：1–50 的十进制整数，不接受前导零。 */
const limitOf = (raw: unknown): number | undefined => {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || !/^[1-9]\d{0,1}$/.test(raw)) throw new QqApiError('input');
  const value = Number(raw);
  if (value > MAX_LIMIT) throw new QqApiError('input');
  return value;
};

/** retcode 非零是上游拒绝；vecSong null／缺省是没有推荐，其他非数组是格式变了。
 * 要在 decode 之后检查：decode 里丢的错误一律会被当成格式错误。 */
const rowsOf = (data: Dictionary): unknown[] => {
  const { retcode } = data;
  if (retcode !== undefined) {
    if (typeof retcode !== 'number' || !Number.isSafeInteger(retcode))
      throw new QqApiError('invalid-response');
    if (retcode !== 0) throw normalizeQqFailure({ source: 'business', upstreamCode: retcode });
  }
  const rows = data.vecSong;
  if (rows === null || rows === undefined) return [];
  if (!Array.isArray(rows)) throw new QqApiError('invalid-response');
  return rows;
};

const decodeDictionary = (data: unknown): Dictionary => {
  if (!isDictionary(data)) throw new QqApiError('invalid-response');
  return data;
};

const autoplayList = (seeds: number[]): MusicuDescriptor<Dictionary> => ({
  module: 'music.recommend.AutoPlayServer',
  method: 'GetAutoPlayList',
  param: { vecSong: seeds, amount: seeds.length, from: 8 },
  readOnly: true,
  operation: 'recommend.autoplay',
  decode: decodeDictionary,
});

/** 没有推荐回 200 空数组；有条目却一首都读不出来回 502，不当成「没有」。 */
export const autoplayResult = async (
  session: AuthSession | null,
  query: { songids: unknown; limit: unknown },
  options: SessionMusicuOptions = {},
): Promise<NewRouteResult> => {
  try {
    if (!session) throw new QqApiError('auth-missing');
    const seeds = seedsOf(query.songids);
    const limit = limitOf(query.limit);
    const rows = rowsOf(
      await createSessionMusicuClient(session, options).execute(autoplayList(seeds)),
    );
    const songs = rows.map(toTrack).filter((item) => item !== null);
    if (rows.length && !songs.length) throw new QqApiError('invalid-response');
    return okResult({ songs: limit === undefined ? songs : songs.slice(0, limit) });
  } catch (error) {
    return failureResult('get-autoplay', error);
  }
};

// `/recommend/autoplay/similar`：按一首歌接相似的歌。实测（2026-11，带会话）官方 App 送
// `AutoPlayServer.GetRadioSimilarSongs { vecSong: [一首], amount: 3, from: 4 }`，回 3 首 `{ track }` 和一个标题，
// 标题不交出。和 `/song/similar`（TrackRelationServer）、`/recommend/autoplay` 都是不同的上游。
const similarList = (seed: number): MusicuDescriptor<Dictionary> => ({
  module: 'music.recommend.AutoPlayServer',
  method: 'GetRadioSimilarSongs',
  param: { vecSong: [seed], amount: 3, from: 4 },
  readOnly: true,
  operation: 'recommend.autoplay-similar',
  decode: decodeDictionary,
});

/** 只收一首种子；没有相似的歌回 200 空数组，有条目却读不出来回 502。 */
export const similarAutoplayResult = async (
  session: AuthSession | null,
  rawId: unknown,
  options: SessionMusicuOptions = {},
): Promise<NewRouteResult> => {
  try {
    if (!session) throw new QqApiError('auth-missing');
    const seed = songIdOf(rawId);
    const rows = rowsOf(
      await createSessionMusicuClient(session, options).execute(similarList(seed)),
    );
    const songs = rows.map(toTrack).filter((item) => item !== null);
    if (rows.length && !songs.length) throw new QqApiError('invalid-response');
    return okResult({ songs });
  } catch (error) {
    return failureResult('get-autoplay-similar', error);
  }
};
