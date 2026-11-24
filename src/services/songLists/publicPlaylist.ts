import { WEB_ANONYMOUS_COMM } from '../../protocol/clientProfiles';
import type { HttpTransport } from '../../protocol/http';
import { createMusicuClient } from '../../protocol/musicu';
import { createFetchTransport } from '../../transport/fetch';
import { logger } from '../../util/logger';
import { type Dictionary, dictionaryOf, isDictionary, numberOf } from '../../util/values';
import { type SongListDetailResponse, toSongListDetailResponse } from './officialPlaylist';
import { hasMoreOf, songIdOf, songsOf } from './songListPages';

// src/services/songLists/publicPlaylist.ts
//
// 匿名读一张公开歌单（musicu 的 `uniform_get_Dissinfo`，网页身份、不带 Cookie）。旧歌单 CGI 在中国大陆
// 出口对部分公开歌单回 `code 0 / subcode 4000`（`check privacy error!`），没有歌单内容；海外出口正常
// （2026-11 对照实测）。这条匿名接口在两边都读得到同一张歌单，所以只在那时拿来补。

const DISSTID_PATTERN = /^[1-9]\d{0,15}$/;

const isZeroOrMissing = (value: unknown): boolean =>
  value === undefined || value === null || numberOf(value) === 0;

/** 里层码为 0（或没给）、歌单 id 对得上、`dir_show` 为 1（公开）才算读到这张公开歌单。 */
const isReadablePublicPage = (page: Dictionary, disstid: string): boolean =>
  isDictionary(page.dirinfo) &&
  isZeroOrMissing(page.code) &&
  isZeroOrMissing(page.subcode) &&
  String(dictionaryOf(page.dirinfo).id) === disstid &&
  numberOf(dictionaryOf(page.dirinfo).dir_show) === 1;

export interface PublicSongListReadOptions {
  /** 测试注入；默认用全局 fetch，与其他匿名 musicu 读取同一种出站方式。 */
  http?: HttpTransport;
}

/**
 * 一页 150 首。中国大陆出口实测：150 首一页 8–13 秒；300 首 26 秒或超时；1000 首 34 秒或 40 秒超时
 * （2026-11-24，耗时大致跟回包大小成正比），而每次请求只等 25 秒。
 */
export const PUBLIC_SONG_LIST_PAGE_SIZE = 150;

/** 最多读这么多页（1500 首）；更大的歌单不改写，保留原回应。 */
export const PUBLIC_SONG_LIST_MAX_PAGES = 10;

/** 第一页之后最多同时读几页：607 首的歌单两轮读完，不用一页接一页等。 */
export const PUBLIC_SONG_LIST_CONCURRENCY = 3;

const countOf = (value: unknown): number | undefined =>
  value === null || value === undefined || value === '' ? undefined : numberOf(value);

const logNotRewritten = (reason: string, pages: number, items: number, total?: number) =>
  logger.warn('service.public_fallback_incomplete', {
    service: 'songListDetail',
    reason,
    pages,
    items,
    ...(total !== undefined && Number.isSafeInteger(total) ? { upstreamTotal: total } : {}),
  });

/**
 * 读到并核对过（里层码为 0、歌单 id 对得上、`dir_show` 为 1）、而且**整张读完**才返回改写成旧 CGI 形状的
 * 结果；歌单 id 不是正整数、核对不过、超过页数上限、中间有一页不满或重复、读到的歌数对不上总数，都返回
 * `null`，让调用方保留原回应（Folia 自己还有逐页的回退）。上游拒绝或连不上会抛错，同样交给调用方。
 */
export const readPublicSongListDetail = async (
  disstid: string,
  options: PublicSongListReadOptions = {},
): Promise<SongListDetailResponse | null> => {
  if (!DISSTID_PATTERN.test(disstid)) return null;
  const id = Number(disstid);
  if (!Number.isSafeInteger(id)) return null;

  const client = createMusicuClient({
    http: options.http ?? createFetchTransport(),
    comm: WEB_ANONYMOUS_COMM,
    maxRetries: 0,
  });
  const size = PUBLIC_SONG_LIST_PAGE_SIZE;
  const readPage = async (songBegin: number): Promise<Dictionary> =>
    dictionaryOf(
      await client.execute({
        module: 'music.srfDissInfo.aiDissInfo',
        method: 'uniform_get_Dissinfo',
        param: {
          disstid: id,
          userinfo: 1,
          tag: 1,
          orderlist: 1,
          song_begin: songBegin,
          song_num: size,
          onlysonglist: 0,
          enc_host_uin: '',
        },
        readOnly: true,
        operation: 'playlist.public-detail',
      }),
    );

  const first = await readPage(0);
  if (!isReadablePublicPage(first, disstid)) return null;
  const songs = [...songsOf(first)];
  const total = countOf(first.total_song_num) ?? countOf(dictionaryOf(first.dirinfo).songnum);
  const finish = () =>
    toSongListDetailResponse({ ...first, songlist: songs, hasmore: 0 }, { publicPlaylist: true });

  if (total === undefined) {
    // 不知道总数就没法按偏移量分页：上游也说没有更多才算读完。
    if (hasMoreOf(first)) {
      logNotRewritten('unknown-total', 1, songs.length);
      return null;
    }
    return finish();
  }
  if (songs.length >= total) return finish();
  if (songs.length !== size) {
    logNotRewritten('short-page', 1, songs.length, total);
    return null;
  }
  const pagesNeeded = Math.ceil(total / size);
  if (pagesNeeded > PUBLIC_SONG_LIST_MAX_PAGES) {
    logNotRewritten('limit', 1, songs.length, total);
    return null;
  }

  const offsets: number[] = [];
  for (let page = 1; page < pagesNeeded; page += 1) offsets.push(page * size);
  const pages: Dictionary[] = [];
  for (let start = 0; start < offsets.length; start += PUBLIC_SONG_LIST_CONCURRENCY) {
    const batch = offsets.slice(start, start + PUBLIC_SONG_LIST_CONCURRENCY);
    pages.push(...(await Promise.all(batch.map(readPage))));
  }

  const seen = new Set(songs.map(songIdOf).filter(Boolean));
  for (const [index, page] of pages.entries()) {
    const pageSongs = songsOf(page);
    const last = index === pages.length - 1;
    // 认不出身份的歌一律当成新的，不拿来判断重复。
    const repeated =
      pageSongs.length > 0 &&
      pageSongs.every((song) => {
        const songId = songIdOf(song);
        return songId !== '' && seen.has(songId);
      });
    if (repeated || (!last && pageSongs.length !== size) || pageSongs.length === 0) {
      logNotRewritten(repeated ? 'repeated-page' : 'short-page', index + 2, songs.length, total);
      return null;
    }
    for (const song of pageSongs) {
      const songId = songIdOf(song);
      if (songId) seen.add(songId);
    }
    songs.push(...pageSongs);
  }
  if (songs.length < total) {
    logNotRewritten('short-page', pages.length + 1, songs.length, total);
    return null;
  }
  return finish();
};
