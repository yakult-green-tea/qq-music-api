import { WEB_ANONYMOUS_COMM } from '../../protocol/clientProfiles';
import type { HttpTransport } from '../../protocol/http';
import { createMusicuClient } from '../../protocol/musicu';
import { createFetchTransport } from '../../transport/fetch';
import { logger } from '../../util/logger';
import { type Dictionary, dictionaryOf, isDictionary, numberOf } from '../../util/values';
import { type SongListDetailResponse, toSongListDetailResponse } from './officialPlaylist';
import { collectSongListPages, type SongListPages } from './songListPages';

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

const UNREADABLE = Symbol('unreadable-public-playlist');

export interface PublicSongListReadOptions {
  /** 测试注入；默认用全局 fetch，与其他匿名 musicu 读取同一种出站方式。 */
  http?: HttpTransport;
}

/**
 * 读到并核对过（里层码为 0、歌单 id 对得上、`dir_show` 为 1）就返回改写成旧 CGI 形状的结果；
 * 歌单 id 不是正整数或核对不过返回 `null`。上游拒绝或连不上会抛错，交给调用方保留原回应。
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
  const readPage = async (songBegin: number, songNum: number): Promise<Dictionary> =>
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
          song_num: songNum,
          onlysonglist: 0,
          enc_host_uin: '',
        },
        readOnly: true,
        operation: 'playlist.public-detail',
      }),
    );

  let pagesRead: SongListPages;
  try {
    pagesRead = await collectSongListPages(async (songBegin, songNum) => {
      const page = await readPage(songBegin, songNum);
      // 第一页就核对，对不上不再往下读。
      if (songBegin === 0 && !isReadablePublicPage(page, disstid)) throw UNREADABLE;
      return page;
    });
  } catch (error) {
    if (error === UNREADABLE) return null;
    throw error;
  }
  const { first, songs, pages, complete, stopReason, upstreamTotal } = pagesRead;
  if (!complete && stopReason)
    logger.warn('service.paging_stopped', {
      service: 'songListDetail',
      source: 'public-fallback',
      reason: stopReason,
      pages,
      items: songs.length,
      ...(upstreamTotal !== undefined && Number.isSafeInteger(upstreamTotal)
        ? { upstreamTotal }
        : {}),
    });
  return toSongListDetailResponse(
    { ...first, songlist: songs, hasmore: complete ? 0 : 1 },
    { publicPlaylist: true },
  );
};
