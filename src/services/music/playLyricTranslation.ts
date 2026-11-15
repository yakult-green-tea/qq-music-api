import { LITE_ANONYMOUS_COMM, LITE_ANONYMOUS_HEADERS } from '../../protocol/clientProfiles';
import { createMusicuClient, type MusicuDescriptor } from '../../protocol/musicu';
import { createFetchTransport } from '../../transport/fetch';

// src/services/music/playLyricTranslation.ts
//
// `/getLyric?trans=1` 的翻译补强。旧歌词接口的 `trans` 很多是空的；`GetPlayLyricInfo` 带 `crypt: 0` 时
// `trans` 是可读的 base64 LRC（`lyric` 仍是密文，这里不用）。实测（2026-10）11 首里旧接口 0 首有翻译、
// 新接口 4 首有，只送 songMID 也读得到。用和匿名搜索同一个精简版匿名身份，不需要会话。
// 这只是补充：只试一次、不重试，拿不到可读翻译就返回 undefined，由调用方保留旧接口的结果。
// 零依赖，两个运行时共用。

/** 至少要有一个 `[mm:ss` 时间标记，才算可读的 LRC；密文或乱码都不算。 */
const LRC_TIME_TAG = /\[\d{1,3}:\d{2}/;
const TIMEOUT_MS = 10_000;

const decodeBase64Utf8 = (value: string): string =>
  new TextDecoder().decode(Uint8Array.from(atob(value), (character) => character.charCodeAt(0)));

const readableTranslationOf = (data: unknown): string | undefined => {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined;
  const { trans } = data as Record<string, unknown>;
  if (typeof trans !== 'string' || !trans) return undefined;
  try {
    return LRC_TIME_TAG.test(decodeBase64Utf8(trans)) ? trans : undefined;
  } catch {
    return undefined;
  }
};

const translationRequest = (songmid: string): MusicuDescriptor<string | undefined> => ({
  module: 'music.musichallSong.PlayLyricInfo',
  method: 'GetPlayLyricInfo',
  param: {
    songMID: songmid,
    songName: '',
    singerName: '',
    albumName: '',
    interval: 0,
    crypt: 0,
    ct: 19,
    cv: 2111,
    lrc_t: 0,
    qrc: 0,
    qrc_t: 0,
    roma: 0,
    roma_t: 0,
    trans: 1,
    trans_t: 0,
    type: 0,
  },
  readOnly: true,
  operation: 'lyric.translation',
  decode: readableTranslationOf,
});

/** 返回 base64 的翻译 LRC；没有、读不出或请求失败都是 undefined。 */
export const playLyricTranslation = async (songmid: string): Promise<string | undefined> => {
  if (!songmid) return undefined;
  try {
    return await createMusicuClient({
      http: createFetchTransport(),
      comm: LITE_ANONYMOUS_COMM,
      headers: LITE_ANONYMOUS_HEADERS,
      timeoutMs: TIMEOUT_MS,
      maxRetries: 0,
    }).execute(translationRequest(songmid));
  } catch {
    return undefined;
  }
};
