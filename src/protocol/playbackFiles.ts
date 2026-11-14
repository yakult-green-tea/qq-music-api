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

/** 文件格式，按扩展名记；是从文件名推出来的，没读过文件内容。 */
export type PlaybackCodec = 'mp3' | 'm4a' | 'flac' | 'ape';

export interface PlaybackFileInfo {
  /** 文件名前缀对应的音质；试听文件是 `preview`。 */
  quality: `${PlaybackFileQuality}` | 'preview';
  codec: PlaybackCodec;
  /** 这几种前缀都是未加密的文件；官方客户端用的加密文件前缀不在这里，认不出就不填。 */
  encryption: 'none';
}

const FILE_PREFIXES: Readonly<
  Record<string, { quality: PlaybackFileInfo['quality']; extension: string }>
> = {
  ...Object.fromEntries(
    Object.entries(PLAYBACK_FILE_TYPES).map(([quality, type]) => [
      type.prefix,
      { quality: quality as `${PlaybackFileQuality}`, extension: type.extension },
    ]),
  ),
  RS02: { quality: 'preview', extension: '.mp3' },
};

/**
 * 上游给的 purl（文件名加查询参数）是哪一种文件。只认上面几种前缀、而且扩展名要对得上；
 * 认不出（包括测试里的假文件名、加密文件）就回 undefined，不拿要的音质去顶。
 */
export const playbackFileOfPurl = (purl: string): PlaybackFileInfo | undefined => {
  const name = purl.split('?')[0];
  const match = /^([A-Z0-9]{4})[A-Za-z0-9]{1,64}(\.[a-z0-9]{2,4})$/.exec(name);
  if (!match) return undefined;
  const known = FILE_PREFIXES[match[1]];
  if (!known || known.extension !== match[2]) return undefined;
  return {
    quality: known.quality,
    codec: known.extension.slice(1) as PlaybackCodec,
    encryption: 'none',
  };
};
