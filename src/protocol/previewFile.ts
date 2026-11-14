// src/protocol/previewFile.ts
//
// 试听文件（`RS02{media id}.mp3`）要不要去要。2026-10 真账号实测：`size_try` 是 0 的歌上游照样给 RS02 链接，
// CDN 却 404；size_try 大于 0 代表有试听文件，不代表文件大小。文件名用 songmid 代替 media_mid 也会 404。
// 所以只有单曲详情里确认 `size_try > 0`、又有可信的
// media id 才去要；其他一律不要，也不拿 songmid 猜。只依赖 protocol 里的纯模块，两个运行时共用。

import { type PlaybackHint, previewMissingHint, previewUnavailableHint } from './playbackHints';
import {
  classifyPlaybackRestriction,
  type PlaybackRestriction,
  playbackQualityOf,
} from './playbackRestriction';

const MEDIA_ID_PATTERN = /^[A-Za-z0-9]{14}$/;

const read = (value: unknown, key: string): unknown => {
  try {
    return value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
  } catch {
    return undefined;
  }
};

/** 只认 14 个字母或数字（前后空白去掉）；其他都当没给。 */
export const validMediaIdOf = (value: unknown): string | undefined => {
  const text = typeof value === 'string' ? value.trim() : '';
  return MEDIA_ID_PATTERN.test(text) ? text : undefined;
};

/** 安全整数照收，纯数字字符串换成整数，其他都当没有。 */
const integerOf = (value: unknown): number | undefined => {
  const parsed = typeof value === 'string' && /^\d{1,15}$/.test(value) ? Number(value) : value;
  return typeof parsed === 'number' && Number.isSafeInteger(parsed) ? parsed : undefined;
};

/**
 * `trackInfo` 是单曲详情（`track_info`），读不到时是 `undefined`；`callerMediaId` 是前端给的、已经验过的 media id。
 * 能要试听文件就回文件名要用的 media id（前端给的优先，否则详情里的 `file.media_mid`），不能就回 `undefined`。
 */
export const previewMediaIdOf = (
  trackInfo: unknown,
  callerMediaId?: string,
): string | undefined => {
  const file = read(trackInfo, 'file');
  const sizeTry = integerOf(read(file, 'size_try'));
  if (sizeTry === undefined || sizeTry <= 0) return undefined;
  return callerMediaId ?? validMediaIdOf(read(file, 'media_mid'));
};

/**
 * 详情宣告的试听长度（`file.e_30s`，毫秒）。实测两首（30 秒、60 秒）都和下载下来的试听文件一样长。
 * 不是正整数就当没有，不拿 30 秒顶上。
 */
export const previewDurationMsOf = (trackInfo: unknown): number | undefined => {
  const value = integerOf(read(read(trackInfo, 'file'), 'e_30s'));
  return value !== undefined && value > 0 ? value : undefined;
};

/** 详情里 `size_try` 正好是 0（整数或纯数字字符串）才算确定没有试听文件；缺字段、负数、读不到都不算。 */
export const previewFileMissingOf = (trackInfo: unknown): boolean =>
  integerOf(read(read(trackInfo, 'file'), 'size_try')) === 0;

/** 不要试听文件的那首歌：和拿不到链接一样是 `url_unavailable`，提示是「试听不可用」。 */
export const previewUnavailableRestriction = (
  authenticated: boolean,
  missing = false,
): PlaybackRestriction & { hint: PlaybackHint } => ({
  ...classifyPlaybackRestriction({
    quality: playbackQualityOf('preview'),
    authenticated,
    codes: {},
  }),
  hint: missing ? previewMissingHint() : previewUnavailableHint(),
});
