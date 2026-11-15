import { CLIENT_COMM_OF } from '../../protocol/clientProfiles';
import { playbackEntryCodesOf, playbackUnavailableLogOf } from '../../protocol/playbackDiagnostics';
import {
  ENCRYPTED_PLAYBACK_FILES,
  type EncryptedPlaybackQuality,
} from '../../protocol/playbackFiles';
import { playbackHintOf } from '../../protocol/playbackHints';
import {
  type PlaybackSource,
  playbackPlayabilityOf,
  publicPlayEntryOf,
} from '../../protocol/playbackSource';
import { validMediaIdOf } from '../../protocol/previewFile';
import { logger } from '../../util/logger';
import { type Dictionary, dictionaryOf, stringOf } from '../../util/values';
import type { AuthHttpClient } from './httpClient';
import { callMusicu } from './musicuProtocol';
import { PREFERRED_STREAM_DOMAIN } from './playback';
import { withBoundedPlaybackHttp } from './playbackFallback';
import { encryptedEvKeyStrategy } from './playbackStrategies';
import type { AuthSession } from './qrTypes';

const streamUrlOf = (value: string, base?: string): URL | undefined => {
  if (!value || Array.from(value).some((character) => character <= ' ' || character === '\\'))
    return undefined;
  try {
    const url = new URL(value, base);
    if (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.hash &&
      /^[a-z0-9-]+\.stream\.qqmusic\.qq\.com$/.test(url.hostname)
    )
      return url;
  } catch {
    return undefined;
  }
};

const unavailable = (songmid: string, quality: EncryptedPlaybackQuality, entry?: Dictionary) => {
  logger.debug(
    'playback.url-unavailable',
    playbackUnavailableLogOf({
      phase: 'get-encrypted-music-play',
      index: 0,
      quality,
      entry,
    }),
  );
  const codes = playbackEntryCodesOf(entry);
  return {
    [songmid]: {
      url: '',
      error: '暂无播放链接',
      restriction: {
        key: 'url_unavailable',
        evidence: 'observed-response',
        ...(Object.keys(codes).length ? { codes } : {}),
        hint: playbackHintOf(undefined),
      },
    },
  };
};

export const getEncryptedPlayUrls = (
  http: AuthHttpClient,
  auth: AuthSession,
  songmid: string,
  quality: EncryptedPlaybackQuality,
): Promise<Dictionary> =>
  withBoundedPlaybackHttp(http, async (bounded) => {
    const detail = await callMusicu(
      bounded,
      auth.device,
      'get-encrypted-play-detail',
      'music.pf_song_detail_svr',
      'get_song_detail_yqq',
      { song_type: 0, song_mid: songmid },
      auth.credential,
    );
    const track = dictionaryOf(detail.track_info);
    const mediaMid = validMediaIdOf(dictionaryOf(track.file).media_mid);
    if (!mediaMid || (track.mid !== undefined && track.mid !== songmid))
      return unavailable(songmid, quality);

    const strategy = encryptedEvKeyStrategy(quality);
    const filename = strategy.filenameOf(songmid, mediaMid);
    const reply = await strategy.request(
      {
        http: bounded,
        auth,
        guid: globalThis.crypto.randomUUID().replaceAll('-', ''),
        phase: 'get-encrypted-music-play',
      },
      [{ songmid, filename }],
    );
    const entries = (Array.isArray(reply.midurlinfo) ? reply.midurlinfo : [])
      .map(dictionaryOf)
      .filter((item) => item.songmid === songmid);
    if (entries.length !== 1) return unavailable(songmid, quality);
    const [entry] = entries;
    const codes = playbackEntryCodesOf(entry);
    const ekey = stringOf(entry.ekey);
    const purl = stringOf(entry.purl);
    if (
      codes.result !== 0 ||
      (codes.code ?? 0) !== 0 ||
      (codes.errtype ?? 0) !== 0 ||
      !ekey.trim() ||
      !purl ||
      (entry.filename !== undefined && entry.filename !== filename)
    )
      return unavailable(songmid, quality, entry);

    const sip = (Array.isArray(reply.sip) ? reply.sip : [])
      .map((value) => streamUrlOf(stringOf(value)))
      .filter(
        (value): value is URL => value !== undefined && value.pathname === '/' && !value.search,
      );
    const responseBase = sip.find((url) => !url.hostname.startsWith('ws.')) ?? sip[0];
    const url = streamUrlOf(purl, responseBase?.href ?? PREFERRED_STREAM_DOMAIN);
    const { prefix, extension } = ENCRYPTED_PLAYBACK_FILES[quality];
    const shortFilename = `${prefix}${mediaMid}${extension}`;
    if (!url || (url.pathname !== `/${filename}` && url.pathname !== `/${shortFilename}`))
      return unavailable(songmid, quality, entry);

    const cdn =
      responseBase || /^(?:https?:)?\/\//i.test(purl) ? 'response-sip' : 'unverified-default';
    const encryption = 'encrypted';
    const source: PlaybackSource = {
      songmid,
      mediaMid,
      kind: 'full',
      requestedQuality: quality,
      attemptedQuality: quality,
      deliveredQuality: quality,
      codec: ENCRYPTED_PLAYBACK_FILES[quality].codec,
      encryption,
      protocol: strategy.id,
      deviceProfile: 'android',
      client: CLIENT_COMM_OF.android,
      url: url.href,
      granted: true,
      cdn,
      access: 'full',
      playability: playbackPlayabilityOf({ granted: true, encryption, cdn }),
      audioVerified: false,
      codes,
    };
    const result = publicPlayEntryOf(source);
    return { [songmid]: { ...result, source: { ...result.source, encryption, ekey } } };
  });
