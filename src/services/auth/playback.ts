import { playbackEntryCodesOf, playbackUnavailableLogOf } from '../../protocol/playbackDiagnostics';
import {
  fullFilenameOf,
  PLAYBACK_FILE_TYPES,
  playbackFileTypeOf,
  previewFilenameOf,
} from '../../protocol/playbackFiles';
import {
  canLookupPlaybackHint,
  PLAYBACK_HINT_RULES,
  playbackHintOf,
  previewUnavailableHint,
} from '../../protocol/playbackHints';
import { classifyPlaybackRestriction, playbackQualityOf } from '../../protocol/playbackRestriction';
import {
  previewFileMissingOf,
  previewMediaIdOf,
  previewUnavailableRestriction,
  validMediaIdOf,
} from '../../protocol/previewFile';
import {
  apeFileFailureOf,
  BEST_QUALITY_ORDER,
  type BestQuality,
  bestQualityLevelsOf,
  qualityFileRestriction,
} from '../../protocol/qualityFile';
import { logger } from '../../util/logger';
import { type Dictionary, dictionaryOf, identifierOf, numberOf, stringOf } from '../../util/values';
import type { AuthHttpClient } from './httpClient';
import { callMusicu } from './musicuProtocol';
import { type AuthSession, type PlaybackOptions } from './qrTypes';
import { StreamCdnSelector } from './streamCdnSelector';

// src/services/auth/playback.ts
// 从认证入口搬出的同一套实现；协议、状态与对外回包沿用原规则。

/**
 * `music.vkey.GetVkey/UrlGetVkey` answers with `midurlinfo` but an empty `sip`, unlike the legacy
 * web `CgiGetVkey`. Without a fallback the play URL degrades into a bare filename, which the
 * browser then resolves against its own origin. The stream fallback remains the last resort after
 * probing the known responsive route first, then asking QQ's CDN dispatcher for alternatives.
 */
export const DEFAULT_STREAM_DOMAIN = 'http://dl.stream.qqmusic.qq.com/';

export const PREFERRED_STREAM_DOMAIN = 'http://sjy6.stream.qqmusic.qq.com/';

export const PREFERRED_STREAM_HOST = new URL(PREFERRED_STREAM_DOMAIN).hostname;

export const DEFAULT_CDN_REFRESH_MS = 30 * 60 * 1_000;

export const isPreferredStreamDomain = (value: string): boolean => {
  try {
    return new URL(value).hostname.toLowerCase() === PREFERRED_STREAM_HOST;
  } catch {
    return false;
  }
};

/** 文件名规则放在 protocol/playbackFiles；这个名字留给原来的引用。 */
export const MUSIC_FILE_TYPES = PLAYBACK_FILE_TYPES;

/** One request rarely carries more than a few songs; past this many, failures get the default hint. */
export const MAX_PLAYBACK_HINT_LOOKUPS = 10;

/**
 * The song detail as this same session sees it: the restriction and preview fields are computed per
 * account, so another account's (or an anonymous) copy could be wrong. A failure here reads as no
 * detail: the hint stays unconfirmed, and a preview is not asked for.
 */
const songDetailOf = async (
  http: AuthHttpClient,
  auth: AuthSession,
  songmid: string,
  phase: 'get-playback-hint' | 'get-preview-detail' | 'get-quality-detail',
): Promise<unknown> => {
  try {
    const data = await callMusicu(
      http,
      auth.device,
      phase,
      'music.pf_song_detail_svr',
      'get_song_detail_yqq',
      { song_type: 0, song_mid: songmid },
      auth.credential,
    );
    return data.track_info;
  } catch {
    return undefined;
  }
};

export { previewFilenameOf };

/**
 * 试听：每首先查一次单曲详情（并行，最多 `MAX_PLAYBACK_HINT_LOOKUPS` 首，后面的当作查不到），
 * 回能要试听文件的歌和文件名要用的 media id，以及详情确认没有试听文件的歌。
 */
const previewMediaIdsOf = async (
  http: AuthHttpClient,
  auth: AuthSession,
  songmids: string[],
  mediaId: unknown,
): Promise<{ mediaIds: Map<string, string>; missing: Set<string> }> => {
  const callerMediaId = validMediaIdOf(mediaId);
  const looked = [...new Set(songmids)].slice(0, MAX_PLAYBACK_HINT_LOOKUPS);
  const details = await Promise.all(
    looked.map((mid) => songDetailOf(http, auth, mid, 'get-preview-detail')),
  );
  const mediaIds = new Map<string, string>();
  const missing = new Set<string>();
  for (const [index, mid] of looked.entries()) {
    const media = previewMediaIdOf(details[index], callerMediaId);
    if (media) mediaIds.set(mid, media);
    else if (previewFileMissingOf(details[index])) missing.add(mid);
  }
  return { mediaIds, missing };
};

/**
 * quality=best：先查详情（最多 `MAX_PLAYBACK_HINT_LOOKUPS` 首），再按 flac → 320 → 128 一级一级要，每一级把还没拿到
 * 链接、又有那一级文件的歌合成一个请求；拿到就停，条目标出实际音质。128 一定会要，那一级的结果（含提示）原样回传。
 * 不采用一次要全部文件名、看谁有 purl 的做法：绿钻要 ape 时没文件也会拿到假链接。
 */
const bestPlayUrls = async (
  http: AuthHttpClient,
  auth: AuthSession,
  streamCdnSelector: StreamCdnSelector,
  songmids: string[],
  mediaId: string | undefined,
  playbackHintsEnabled: boolean,
): Promise<Dictionary> => {
  const unique = [...new Set(songmids)];
  const looked = unique.slice(0, MAX_PLAYBACK_HINT_LOOKUPS);
  const details = await Promise.all(
    looked.map((mid) => songDetailOf(http, auth, mid, 'get-quality-detail')),
  );
  const levels = new Map<string, BestQuality[]>(unique.map((mid) => [mid, ['128']]));
  for (const [index, mid] of looked.entries()) levels.set(mid, bestQualityLevelsOf(details[index]));
  const playUrl: Dictionary = {};
  let pending = unique;
  for (const level of BEST_QUALITY_ORDER) {
    const batch = pending.filter((mid) => levels.get(mid)?.includes(level));
    if (!batch.length) continue;
    const result = await getAuthenticatedPlayUrls(
      http,
      auth,
      streamCdnSelector,
      batch.join(','),
      level,
      mediaId,
      {},
      playbackHintsEnabled,
    );
    for (const mid of batch) {
      const entry = result[mid];
      if (entry && (level === '128' || stringOf(dictionaryOf(entry).url)))
        playUrl[mid] = { ...dictionaryOf(entry), quality: level };
    }
    pending = level === '128' ? [] : pending.filter((mid) => !playUrl[mid]);
  }
  return playUrl;
};

export const getAuthenticatedPlayUrls = async (
  http: AuthHttpClient,
  auth: AuthSession,
  streamCdnSelector: StreamCdnSelector,
  songmid: string,
  quality: string | number = 128,
  mediaId?: string,
  options: PlaybackOptions = {},
  playbackHintsEnabled = true,
): Promise<Dictionary> => {
  const requestedList = songmid
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (String(quality) === 'best' && !options.preview)
    return bestPlayUrls(
      http,
      auth,
      streamCdnSelector,
      requestedList,
      mediaId,
      playbackHintsEnabled,
    );
  // 试听只要确认有试听文件的歌；确定没有的回「没有试听」，其他的回「试听不可用」，都不去要。
  const preview = options.preview
    ? await previewMediaIdsOf(http, auth, requestedList, mediaId)
    : undefined;
  const previewMediaIds = preview?.mediaIds;
  let songmidList = previewMediaIds
    ? requestedList.filter((mid) => previewMediaIds.has(mid))
    : requestedList;
  const skipped: Dictionary = Object.fromEntries(
    requestedList
      .filter((mid) => previewMediaIds && !previewMediaIds.has(mid))
      .map((mid) => [
        mid,
        {
          url: '',
          error: '暂无播放链接',
          restriction: previewUnavailableRestriction(true, preview?.missing.has(mid)),
        },
      ]),
  );
  if (!options.preview && String(quality) === 'ape') {
    const looked = [...new Set(requestedList)].slice(0, MAX_PLAYBACK_HINT_LOOKUPS);
    const details = new Map(
      await Promise.all(
        looked.map(
          async (mid) => [mid, await songDetailOf(http, auth, mid, 'get-quality-detail')] as const,
        ),
      ),
    );
    songmidList = requestedList.filter((mid) => {
      const reason = apeFileFailureOf(details.get(mid));
      if (!reason) return true;
      skipped[mid] = {
        url: '',
        error: '暂无播放链接',
        restriction: qualityFileRestriction(true, reason),
      };
      return false;
    });
  }
  if (!songmidList.length && (previewMediaIds || String(quality) === 'ape')) return skipped;
  const qualityKey = String(quality) as keyof typeof MUSIC_FILE_TYPES;
  const fileType = playbackFileTypeOf(quality);
  // `globalThis.crypto` is the Web Crypto API global: identical on Node ≥20, Electron, Cloudflare
  // Workers and the Vercel Edge Runtime, unlike `node:crypto`, which the last of those refuses to
  // deploy a bundle importing at all.
  const guid = globalThis.crypto.randomUUID().replaceAll('-', '');
  const normalizedMediaId = stringOf(mediaId).trim();
  const data = await callMusicu(
    http,
    auth.device,
    'get-music-play',
    'music.vkey.GetVkey',
    'UrlGetVkey',
    {
      filename: songmidList.map((mid) =>
        previewMediaIds
          ? previewFilenameOf(previewMediaIds.get(mid) as string)
          : fullFilenameOf(fileType, mid, normalizedMediaId),
      ),
      guid,
      songmid: songmidList,
      songtype: songmidList.map(() => 0),
      uin: stringOf(auth.credential.str_musicid) || String(auth.credential.musicid),
      ctx: 0,
    },
    auth.credential,
  );
  /** 播放链接的域名：先用回应里的 sip，没有就拿第一个 purl 去测 CDN；都没有时回 undefined。 */
  const streamDomainOf = async (payload: Dictionary): Promise<string | undefined> => {
    const sip = Array.isArray(payload.sip) ? payload.sip.map(stringOf).filter(Boolean) : [];
    let domain: string | undefined = sip.find((value) => !value.startsWith('http://ws')) ?? sip[0];
    if (!domain) {
      const firstPurl = (Array.isArray(payload.midurlinfo) ? payload.midurlinfo : [])
        .map(dictionaryOf)
        .map((item) => stringOf(item.purl))
        .find(Boolean);
      if (firstPurl) {
        try {
          // sjy6 is the responsive compatible route observed across authenticated playback. Trying
          // it first keeps the common Serverless path to one Range request instead of dispatch + N.
          domain =
            (await streamCdnSelector.select([PREFERRED_STREAM_DOMAIN], firstPurl)) ?? undefined;
          if (!domain) {
            const dispatch = await callMusicu(
              http,
              auth.device,
              'get-cdn-dispatch',
              'music.audioCdnDispatch.cdnDispatch',
              'GetCdnDispatch',
              {
                guid,
                uid: '0',
                use_new_domain: 1,
                use_ipv6: 1,
              },
              auth.credential,
            );
            const dispatchSip = Array.isArray(dispatch.sip)
              ? dispatch.sip.map(stringOf).filter(Boolean)
              : [];
            const alternativeSip = dispatchSip.filter((value) => !isPreferredStreamDomain(value));
            const refreshMs =
              (numberOf(dispatch.refreshTime) ?? DEFAULT_CDN_REFRESH_MS / 1_000) * 1_000;
            domain =
              (await streamCdnSelector.select(
                [...alternativeSip, DEFAULT_STREAM_DOMAIN],
                firstPurl,
                refreshMs,
              )) ?? undefined;
          }
        } catch (error) {
          logger.warn('qq-auth.cdn-selection-failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    return domain;
  };
  const firstDomain = await streamDomainOf(data);
  const domain = firstDomain ?? DEFAULT_STREAM_DOMAIN;
  const playUrl: Dictionary = { ...skipped };
  const entries = Array.isArray(data.midurlinfo) ? data.midurlinfo : [];
  const loggedQuality = options.preview
    ? 'preview'
    : MUSIC_FILE_TYPES[qualityKey]
      ? qualityKey
      : '128';
  const unavailable: Dictionary[] = [];
  for (const [index, entry] of entries.entries()) {
    const item = dictionaryOf(entry);
    const mid = identifierOf(item.songmid);
    if (!mid) continue;
    if (skipped[mid]) continue;
    const purl = stringOf(item.purl);
    // 开发日志（debug）：没链接的那首只记位置、音质和白名单里的数字，不记歌曲 id。
    if (!purl)
      logger.debug(
        'playback.url-unavailable',
        playbackUnavailableLogOf({
          phase: 'get-music-play',
          index,
          quality: String(loggedQuality),
          entry: item,
        }),
      );
    if (purl) {
      playUrl[mid] = {
        url: `${domain}${purl}`,
        error: false,
        ...(options.preview ? { preview: true } : {}),
      };
      continue;
    }
    const restriction: Dictionary = {
      ...classifyPlaybackRestriction({
        quality: playbackQualityOf(loggedQuality),
        authenticated: true,
        codes: playbackEntryCodesOf(item),
      }),
    };
    playUrl[mid] = { url: '', error: '暂无播放链接', restriction };
    unavailable.push({ mid, restriction });
  }
  // 试听拿不到链接一律是「试听不可用」；其他的在还没有验证过的规则时挑不出具体原因，不用多查。
  const contextOf = (restriction: Dictionary) => ({
    authenticated: true,
    quality: String(loggedQuality),
    codes: (restriction.codes ?? {}) as { result?: number; subcode?: number },
  });
  const looked =
    playbackHintsEnabled && !options.preview && PLAYBACK_HINT_RULES.length
      ? unavailable
          .filter(({ restriction }) => canLookupPlaybackHint(contextOf(restriction as Dictionary)))
          .slice(0, MAX_PLAYBACK_HINT_LOOKUPS)
      : [];
  const details = new Map(
    await Promise.all(
      looked.map(
        async ({ mid }) =>
          [mid, await songDetailOf(http, auth, String(mid), 'get-playback-hint')] as const,
      ),
    ),
  );
  for (const { mid, restriction } of unavailable)
    (restriction as Dictionary).hint = options.preview
      ? previewUnavailableHint()
      : playbackHintOf(
          details.get(mid),
          playbackHintsEnabled ? PLAYBACK_HINT_RULES : [],
          contextOf(restriction as Dictionary),
        );
  // 原因没确认时再取一次：只在 m4a／128（quality=best 的最后一级也走这里）、最终提示是 reason-unconfirmed 时，
  // 同一会话、同一首、同一音质再要一次，合成一个请求，每首最多多 1 次。地区、会员这些已有具体提示的不再取。
  // 再取仍没给或请求本身出错时，保留第一次的结果，不让整个回应失败。
  const retryList =
    options.preview || !['m4a', '128'].includes(String(loggedQuality))
      ? []
      : unavailable
          .filter(
            ({ restriction }) =>
              dictionaryOf((restriction as Dictionary).hint).key === 'playback.reason-unconfirmed',
          )
          .map(({ mid }) => String(mid));
  if (retryList.length) {
    try {
      const retry = await callMusicu(
        http,
        auth.device,
        'get-music-play-retry',
        'music.vkey.GetVkey',
        'UrlGetVkey',
        {
          filename: retryList.map((mid) => fullFilenameOf(fileType, mid, normalizedMediaId)),
          guid,
          songmid: retryList,
          songtype: retryList.map(() => 0),
          uin: stringOf(auth.credential.str_musicid) || String(auth.credential.musicid),
          ctx: 0,
        },
        auth.credential,
      );
      const retrySip = Array.isArray(retry.sip) ? retry.sip.map(stringOf).filter(Boolean) : [];
      const retryDomain =
        (retrySip.length || !firstDomain ? await streamDomainOf(retry) : firstDomain) ??
        DEFAULT_STREAM_DOMAIN;
      for (const entry of Array.isArray(retry.midurlinfo) ? retry.midurlinfo : []) {
        const item = dictionaryOf(entry);
        const mid = identifierOf(item.songmid);
        const purl = stringOf(item.purl);
        if (mid && purl && retryList.includes(mid))
          playUrl[mid] = { url: `${retryDomain}${purl}`, error: false };
      }
    } catch {
      // 第一次的结果已经在 playUrl 里。
    }
  }
  return playUrl;
};
