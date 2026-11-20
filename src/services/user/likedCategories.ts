import { normalizeQqFailure, QqApiError } from '../../protocol/errors';
import type { MusicuDescriptor } from '../../protocol/musicu';
import { type Dictionary, dictionaryOf, isDictionary } from '../../util/values';
import type { AuthSession } from '../auth/qrLogin';
import { failureResult, type NewRouteResult, okResult } from '../recommend/newRouteResult';
import { createSessionMusicuClient, type SessionMusicuOptions } from '../recommend/sessionMusicu';

// src/services/user/likedCategories.ts
//
// `/user/liked-songs/categories`：「我喜欢」的分类（建议、歌手、时间、流派）。Node 与 serverless 共用，只读。
// 实测（2026-11，带会话）：官方 App 把整份「我喜欢」送给
// `music.mobileAsset.SongFavCategory.GetCategoryInfo { songlist: [{ song_id, song_type: 13, singers_id }] }`，
// 回 `t_Suggest`、`t_Artist`、`t_Period`、`t_Genre` 四组，每组 `{ title, id, fail, list: [{ title, id,
// category_key, list: [{ song_id }] }] }`。歌手组的标题是空的、category_key 是歌手 id，名称从同一批歌曲资料补，
// 补不到就留空。这里先分页读「我喜欢」（每页 100，最多 500 首）；只送了一部分、或某一组标了失败，都不说完整。

const PAGE_SIZE = 100;
const MAX_SONGS = 500;
const GROUPS = [
  ['suggest', 't_Suggest'],
  ['artist', 't_Artist'],
  ['period', 't_Period'],
  ['genre', 't_Genre'],
] as const;

const countOf = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const stringOf = (value: unknown): string => (typeof value === 'string' ? value : '');

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

const likedPage = (encryptedUin: string, begin: number): MusicuDescriptor<Dictionary> => ({
  module: 'music.srfDissInfo.DissInfo',
  method: 'CgiGetDiss',
  param: {
    disstid: 0,
    dirid: 201,
    tag: true,
    song_begin: begin,
    song_num: PAGE_SIZE,
    userinfo: true,
    orderlist: true,
    enc_host_uin: encryptedUin,
  },
  readOnly: true,
  operation: 'user.liked-categories',
  decode: decodeDictionary,
});

const categoryInfo = (songlist: Dictionary[]): MusicuDescriptor<Dictionary> => ({
  module: 'music.mobileAsset.SongFavCategory',
  method: 'GetCategoryInfo',
  param: { songlist },
  readOnly: true,
  operation: 'user.liked-categories',
  decode: decodeDictionary,
});

interface LikedSongs {
  songs: Dictionary[];
  singerNames: Map<string, string>;
  total: number | undefined;
  incomplete: boolean;
}

/** 一页一页读，读到总数、读满 500 首、或某页比预期短就停。 */
const readLikedSongs = async (
  client: ReturnType<typeof createSessionMusicuClient>,
  encryptedUin: string,
): Promise<LikedSongs> => {
  const songs: Dictionary[] = [];
  const seen = new Set<number>();
  const singerNames = new Map<string, string>();
  let total: number | undefined;
  let firstTotal: unknown;
  let incomplete = false;
  for (let begin = 0; begin < MAX_SONGS; begin += PAGE_SIZE) {
    const page = await client.execute(likedPage(encryptedUin, begin));
    checkInnerCodes(page);
    if (begin === 0) {
      firstTotal = page.total_song_num;
      total = countOf(firstTotal);
    } else if (page.total_song_num !== firstTotal) incomplete = true;
    const list = page.songlist;
    if (list !== null && list !== undefined && !Array.isArray(list))
      throw new QqApiError('invalid-response');
    const rows = Array.isArray(list) ? list : [];
    if (rows.length > PAGE_SIZE) incomplete = true;
    for (const row of rows) {
      const item = dictionaryOf(row);
      const id = countOf(item.id);
      const singerIds: number[] = [];
      for (const value of Array.isArray(item.singer) ? item.singer : []) {
        const singer = dictionaryOf(value);
        const singerId = countOf(singer.id);
        if (!singerId) continue;
        singerIds.push(singerId);
        const name = stringOf(singer.name);
        if (name && !singerNames.has(String(singerId))) singerNames.set(String(singerId), name);
      }
      if (id && !seen.has(id)) {
        seen.add(id);
        songs.push({ song_id: id, song_type: 13, singers_id: singerIds });
      }
    }
    if (rows.length < PAGE_SIZE) break;
    if (total !== undefined && songs.length >= total) break;
  }
  return {
    songs: songs.slice(0, MAX_SONGS),
    singerNames,
    total,
    incomplete: incomplete || songs.length > MAX_SONGS,
  };
};

const toCategory =
  (type: string, singerNames: Map<string, string>) =>
  (row: unknown): Dictionary | null => {
    if (!isDictionary(row)) return null;
    const id = countOf(row.id);
    const key = stringOf(row.category_key);
    if (id === undefined && !key) return null;
    const title = stringOf(row.title) || (type === 'artist' ? (singerNames.get(key) ?? '') : '');
    const songIds = (Array.isArray(row.list) ? row.list : [])
      .map((entry) => countOf(dictionaryOf(entry).song_id))
      .filter((value): value is number => value !== undefined && value > 0);
    return { ...(id === undefined ? {} : { id }), key, title, songIds };
  };

export const likedCategoriesResult = async (
  session: AuthSession | null,
  options: SessionMusicuOptions = {},
): Promise<NewRouteResult> => {
  try {
    if (!session) throw new QqApiError('auth-missing');
    const encryptedUin = session.credential.encryptUin;
    if (typeof encryptedUin !== 'string' || !encryptedUin) throw new QqApiError('unexpected');
    const client = createSessionMusicuClient(session, options);
    const { songs, singerNames, total, incomplete } = await readLikedSongs(client, encryptedUin);
    const readAll = !incomplete && total !== undefined && songs.length === total;
    if (!songs.length)
      return okResult({
        groups: [],
        checkedSongs: 0,
        totalSongs: total ?? null,
        complete: readAll,
      });
    const data = await client.execute(categoryInfo(songs));
    checkInnerCodes(data);
    if (GROUPS.every(([, key]) => data[key] == null)) throw new QqApiError('invalid-response');
    let anyFailed = false;
    const groups = GROUPS.flatMap(([type, key]) => {
      const group = data[key];
      if (group === null || group === undefined) return [];
      if (!isDictionary(group)) throw new QqApiError('invalid-response');
      const list = group.list;
      if (list !== null && list !== undefined && !Array.isArray(list))
        throw new QqApiError('invalid-response');
      const failed = group.fail === true;
      if (failed) anyFailed = true;
      return [
        {
          type,
          title: stringOf(group.title),
          ...(failed ? { failed: true } : {}),
          categories: (Array.isArray(list) ? list : [])
            .map(toCategory(type, singerNames))
            .filter((item) => item !== null),
        },
      ];
    });
    return okResult({
      groups,
      checkedSongs: songs.length,
      totalSongs: total ?? null,
      complete: readAll && !anyFailed,
    });
  } catch (error) {
    return failureResult('get-liked-categories', error);
  }
};
