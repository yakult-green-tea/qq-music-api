import { type Dictionary, dictionaryOf, identifierOf, numberOf } from '../../util/values';

// src/services/songLists/songListPages.ts
//
// 按 `song_begin` 一页页读完一张歌单（`uniform_get_Dissinfo`）的停止规则。带凭据读算法歌单和匿名读公开歌单
// 都用它，只依赖 `util/values`，Node 与 serverless 共用。上游的 `hasmore` 不可全信：空页、读满
// `total_song_num`、整页都是读过的歌、或读到页数上限都会停。

/** 实测一页 1000 首可以一次读完 761 首的歌单；再多就续页。 */
export const SONG_LIST_PAGE_SIZE = 1000;

export const SONG_LIST_MAX_PAGES = 10;

export type PagingStopReason = 'limit' | 'empty-page' | 'repeated-page';

export const hasMoreOf = (page: Dictionary): boolean =>
  page.hasmore === true || numberOf(page.hasmore) === 1;

export const songsOf = (data: Dictionary): unknown[] =>
  Array.isArray(data.songlist) ? data.songlist : [];

export const songIdOf = (value: unknown): string => {
  const song = dictionaryOf(value);
  return identifierOf(song.mid ?? song.songmid ?? song.id ?? song.songid);
};

export interface SongListPages {
  /** 第一页的原始回应，歌单资料从这里取。 */
  first: Dictionary;
  /** 各页的歌接起来（去掉整页重复的那一页）。 */
  songs: unknown[];
  pages: number;
  /** 读满总数或上游说没有更多才算读完。 */
  complete: boolean;
  /** 没读完时为什么停。 */
  stopReason?: PagingStopReason;
  upstreamTotal?: number;
}

export const collectSongListPages = async (
  readPage: (songBegin: number, songNum: number) => Promise<Dictionary>,
  pageSize: number = SONG_LIST_PAGE_SIZE,
  maxPages: number = SONG_LIST_MAX_PAGES,
): Promise<SongListPages> => {
  const first = await readPage(0, pageSize);
  const songs = [...songsOf(first)];
  const seen = new Set(songs.map(songIdOf).filter(Boolean));
  const total = numberOf(first.total_song_num);
  const readAll = () => total !== undefined && songs.length >= total;
  let last = first;
  let pages = 1;
  let repeatedPage = false;
  for (let page = 1; page < maxPages; page += 1) {
    if (!hasMoreOf(last) || songsOf(last).length === 0 || readAll()) break;
    last = await readPage(songs.length, pageSize);
    pages += 1;
    const pageSongs = songsOf(last);
    // 上游不理 song_begin、整页都是读过的歌：不接上去，也不再往下读。
    // 认不出身份的歌一律当成新的，不拿来判断重复。
    const repeated = pageSongs.every((song) => {
      const id = songIdOf(song);
      return id !== '' && seen.has(id);
    });
    if (pageSongs.length > 0 && repeated) {
      repeatedPage = true;
      break;
    }
    for (const song of pageSongs) {
      const id = songIdOf(song);
      if (id) seen.add(id);
    }
    songs.push(...pageSongs);
  }
  // 停在上限、空页或重复页时如实标成没读完，而不是照搬最后一页的 hasmore。
  const complete = readAll() || !hasMoreOf(last);
  const stopReason: PagingStopReason | undefined = complete
    ? undefined
    : repeatedPage
      ? 'repeated-page'
      : songsOf(last).length === 0
        ? 'empty-page'
        : 'limit';
  return {
    first,
    songs,
    pages,
    complete,
    ...(stopReason ? { stopReason } : {}),
    ...(total === undefined ? {} : { upstreamTotal: total }),
  };
};
