// src/protocol/playbackFiles.ts
//
// 取播放链接时要的文件名怎么拼。带会话和匿名两条路用同一份规则，零依赖，两个运行时共用。

/** 各音质对应的文件名前缀和扩展名。 */
export const PLAYBACK_FILE_TYPES = {
  m4a: { prefix: 'C400', extension: '.m4a' },
  128: { prefix: 'M500', extension: '.mp3' },
  320: { prefix: 'M800', extension: '.mp3' },
  ape: { prefix: 'A000', extension: '.ape' },
  flac: { prefix: 'F000', extension: '.flac' },
} as const;

export type PlaybackFileQuality = keyof typeof PLAYBACK_FILE_TYPES;
export type PlaybackFileType = (typeof PLAYBACK_FILE_TYPES)[PlaybackFileQuality];

/** 认不出的音质和以前一样退回 128。 */
export const playbackFileTypeOf = (quality: unknown): PlaybackFileType =>
  PLAYBACK_FILE_TYPES[String(quality) as PlaybackFileQuality] ?? PLAYBACK_FILE_TYPES[128];

/**
 * 完整音质的文件名一律是两段识别值：`前缀 + songmid + media_mid + 扩展名`。没有 media_mid 时用 songmid
 * 补上第二段；只送一段的文件名在取链接时仍会拿到 purl，但 CDN 那边会 403。
 */
export const fullFilenameOf = (type: PlaybackFileType, songmid: string, mediaId: unknown): string =>
  `${type.prefix}${songmid}${mediaId || songmid}${type.extension}`;

/**
 * 试听文件：只有一段 14 个字符的 media id，和完整音质的两段文件名不同。不能拿 songmid 代替。
 */
export const previewFilenameOf = (mediaId: string): string => `RS02${mediaId}.mp3`;
