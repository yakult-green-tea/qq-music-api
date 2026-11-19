import {
  ENCRYPTED_PLAYBACK_FILES,
  type EncryptedPlaybackQuality,
  fullFilenameOf,
  type PlaybackFileType,
  previewFilenameOf,
} from '../../protocol/playbackFiles';
import type { PlaybackProtocolId } from '../../protocol/playbackSource';
import type { UpstreamPhase } from '../../util/safeError';
import { type Dictionary, stringOf } from '../../util/values';
import type { AuthHttpClient } from './httpClient';
import { callMusicu, callWebPlayerMusicu } from './musicuProtocol';
import type { AuthSession } from './qrTypes';

// src/services/auth/playbackStrategies.ts
//
// 带会话取播放链接的几种办法，各自管「文件名怎么拼」和「请求怎么送」。选哪一种、失败了怎么办，
// 由 playback.ts 决定；这里不重试、不换办法。各种办法的说明和证据见 protocol/playbackSource。

export interface PlaybackRequestItem {
  songmid: string;
  filename: string;
}

export interface PlaybackStrategyContext {
  http: AuthHttpClient;
  auth: AuthSession;
  /** 同一次请求里的各次取链接共用一个 guid。 */
  guid: string;
  phase: UpstreamPhase;
}

export interface PlaybackStrategy {
  readonly id: PlaybackProtocolId;
  /** `mediaId` 是这首歌文件名要用的 media id；完整文件没有时传空字符串。 */
  filenameOf(songmid: string, mediaId: string): string;
  /** 回上游的 data 原样（`midurlinfo`、`sip` 等），请求级的失败照旧抛出。 */
  request(
    context: PlaybackStrategyContext,
    items: readonly PlaybackRequestItem[],
  ): Promise<Dictionary>;
}

const playbackRequest = (
  { http, auth, guid, phase }: PlaybackStrategyContext,
  items: readonly PlaybackRequestItem[],
  module: string,
  method: string,
): Promise<Dictionary> =>
  callMusicu(
    http,
    auth.device,
    phase,
    module,
    method,
    {
      filename: items.map((item) => item.filename),
      guid,
      songmid: items.map((item) => item.songmid),
      songtype: items.map(() => 0),
      uin: stringOf(auth.credential.str_musicid) || String(auth.credential.musicid),
      ctx: 0,
    },
    auth.credential,
  );

const urlGetVkey: PlaybackStrategy['request'] = (context, items) =>
  playbackRequest(context, items, 'music.vkey.GetVkey', 'UrlGetVkey');

export const encryptedEvKeyStrategy = (quality: EncryptedPlaybackQuality): PlaybackStrategy => ({
  id: 'encrypted-evkey',
  filenameOf: (songmid, mediaId) =>
    fullFilenameOf(ENCRYPTED_PLAYBACK_FILES[quality], songmid, mediaId),
  request: (context, items) =>
    playbackRequest(context, items, 'music.vkey.GetEVkey', 'CgiGetEVkey'),
});

/** 完整文件：按音质的前缀和扩展名拼两段文件名。 */
export const androidVKeyStrategy = (fileType: PlaybackFileType): PlaybackStrategy => ({
  id: 'android-vkey',
  filenameOf: (songmid, mediaId) => fullFilenameOf(fileType, songmid, mediaId),
  request: urlGetVkey,
});

/** 试听文件：同一个接口，文件名只有 media id 一段。 */
export const previewRs02Strategy: PlaybackStrategy = {
  id: 'preview-rs02',
  filenameOf: (_songmid, mediaId) => previewFilenameOf(mediaId),
  request: urlGetVkey,
};

/**
 * 官方网页播放器身份：同一个接口、同样的两段文件名，comm 和标头换成网页播放器那一组，参数照网页多带
 * `loginflag 1`、`platform "20"`。只在安卓身份明确拒绝完整文件时，由备援来用。
 */
export const webSessionVKeyStrategy = (fileType: PlaybackFileType): PlaybackStrategy => ({
  id: 'web-session-vkey',
  filenameOf: (songmid, mediaId) => fullFilenameOf(fileType, songmid, mediaId),
  request: ({ http, auth, guid, phase }, items) =>
    callWebPlayerMusicu(
      http,
      phase,
      'music.vkey.GetVkey',
      'UrlGetVkey',
      {
        filename: items.map((item) => item.filename),
        guid,
        songmid: items.map((item) => item.songmid),
        songtype: items.map(() => 0),
        uin: stringOf(auth.credential.str_musicid) || String(auth.credential.musicid),
        loginflag: 1,
        platform: '20',
      },
      auth.credential,
    ),
});
