import { normalizeQqFailure, QqApiError } from '../../protocol/errors';
import type { MusicuDescriptor } from '../../protocol/musicu';
import { type Dictionary, dictionaryOf, isDictionary } from '../../util/values';
import { hasMoreOf } from '../auth/authenticatedReads';
import type { AuthSession } from '../auth/qrLogin';
import { failureResult, type NewRouteResult, okResult } from '../recommend/newRouteResult';
import { createSessionMusicuClient, type SessionMusicuOptions } from '../recommend/sessionMusicu';

// src/services/user/playlistUpdates.ts
//
// `/user/playlist/updates`：收藏的歌单里哪些有新歌。Node 与 serverless 共用，只读。
// 实测（2026-11，带会话）：官方 App 把收藏歌单整份送给
// `music.musicasset.FavDissRecentUpdate.CgiGetRecentSong { clientOrderDirs: [{ disstid, dirid?, rtime }] }`，
// 回 `{ code, subcode, updateDirs: [{ disstid, update_songnum, update_time, modeMask, recent_song }] }`，
// 只列有更新的歌单。这里先读收藏歌单第一页（最多 100 个），rtime 一律送 0：API 不知道使用者上次看的时间，
// rtime 非 0 的意思也还没验过。rtime 0 时 update_songnum 的确切意思还没有对照证据，原样交出。
// `checked` 只算真的送出去问的歌单；收藏超过一页时 `complete: false`，不假装全查过。

const FAVORITE_PAGE_SIZE = 100;

const stringOf = (value: unknown): string => (typeof value === 'string' ? value : '');
const countOf = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

const decodeDictionary = (data: unknown): Dictionary => {
  if (!isDictionary(data)) throw new QqApiError('invalid-response');
  return data;
};

/** data 里的 code／subcode 非零是上游拒绝（decode 之后检查：decode 丢的错一律算格式错误）。 */
const checkInnerCodes = (data: Dictionary): void => {
  for (const key of ['code', 'subcode']) {
    const value = data[key];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isSafeInteger(value))
      throw new QqApiError('invalid-response');
    if (value !== 0) throw normalizeQqFailure({ source: 'business', upstreamCode: value });
  }
};

/** null／缺省是空，其他非数组是格式变了。 */
const listOf = (value: unknown): unknown[] => {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw new QqApiError('invalid-response');
  return value;
};

const favoritePage = (encryptedUin: string): MusicuDescriptor<Dictionary> => ({
  module: 'music.musicasset.PlaylistFavRead',
  method: 'CgiGetPlaylistFavInfo',
  param: { uin: encryptedUin, offset: 0, size: FAVORITE_PAGE_SIZE },
  readOnly: true,
  operation: 'user.playlist-updates',
  decode: decodeDictionary,
});

interface OrderDir {
  disstid: number;
  dirid?: number;
  rtime: 0;
}

const orderDirOf = (row: unknown): OrderDir | null => {
  const item = dictionaryOf(row);
  const disstid = countOf(item.tid);
  if (!disstid) return null;
  const dirid = countOf(item.dirId);
  return dirid ? { disstid, dirid, rtime: 0 } : { disstid, rtime: 0 };
};

const recentSongs = (dirs: OrderDir[]): MusicuDescriptor<Dictionary> => ({
  module: 'music.musicasset.FavDissRecentUpdate',
  method: 'CgiGetRecentSong',
  param: { clientOrderDirs: dirs },
  readOnly: true,
  operation: 'user.playlist-updates',
  decode: decodeDictionary,
});

const latestSongOf = (value: unknown): Dictionary | undefined => {
  const first = dictionaryOf(Array.isArray(value) ? value[0] : undefined);
  const id = countOf(first.id);
  if (!id) return undefined;
  const singers = (Array.isArray(first.singer) ? first.singer : []).filter(
    (name): name is string => typeof name === 'string' && name.length > 0,
  );
  return { id, name: stringOf(first.name), singers };
};

const updateOf =
  (asked: Set<number>) =>
  (row: unknown): Dictionary | null => {
    const item = dictionaryOf(row);
    const id = countOf(item.disstid);
    if (!id || !asked.has(id)) return null;
    const latestSong = latestSongOf(item.recent_song);
    const newSongCount = countOf(item.update_songnum);
    const updateTime = countOf(item.update_time);
    return {
      id,
      ...(newSongCount === undefined ? {} : { newSongCount }),
      ...(updateTime === undefined ? {} : { updateTime }),
      ...(latestSong ? { latestSong } : {}),
    };
  };

/** 没有更新回 200 空数组；有条目却一个都读不出来回 502，不当成「没有」。 */
export const playlistUpdatesResult = async (
  session: AuthSession | null,
  options: SessionMusicuOptions = {},
): Promise<NewRouteResult> => {
  try {
    if (!session) throw new QqApiError('auth-missing');
    const encryptedUin = session.credential.encryptUin;
    if (typeof encryptedUin !== 'string' || !encryptedUin) throw new QqApiError('unexpected');
    const client = createSessionMusicuClient(session, options);
    const favorites = await client.execute(favoritePage(encryptedUin));
    checkInnerCodes(favorites);
    if (favorites.v_failTids != null && !Array.isArray(favorites.v_failTids))
      throw new QqApiError('invalid-response');
    const rows = listOf(favorites.v_list);
    const parsed = rows.map(orderDirOf);
    const unique = new Map<number, OrderDir>();
    for (const item of parsed)
      if (item && !unique.has(item.disstid)) unique.set(item.disstid, item);
    const dirs = [...unique.values()].slice(0, FAVORITE_PAGE_SIZE);
    const total = countOf(favorites.total);
    const complete =
      !hasMoreOf(favorites) &&
      !(Array.isArray(favorites.v_failTids) && favorites.v_failTids.length > 0) &&
      !parsed.includes(null) &&
      rows.length <= FAVORITE_PAGE_SIZE &&
      (total === undefined || total <= dirs.length);
    if (!dirs.length) return okResult({ playlists: [], checked: 0, complete });
    const answer = await client.execute(recentSongs(dirs));
    checkInnerCodes(answer);
    const updates = listOf(answer.updateDirs);
    const asked = new Set(dirs.map((dir) => dir.disstid));
    const playlists = updates.map(updateOf(asked)).filter((item) => item !== null);
    if (
      updates.length &&
      !playlists.length &&
      updates.every((row) => !countOf(dictionaryOf(row).disstid))
    )
      throw new QqApiError('invalid-response');
    return okResult({ playlists, checked: dirs.length, complete });
  } catch (error) {
    return failureResult('get-playlist-updates', error);
  }
};
