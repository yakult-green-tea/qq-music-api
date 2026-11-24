// src/protocol/playbackHints.ts
//
// 某首歌拿不到播放链接时，给使用者看的原因（`restriction.hint`）。只是提示：不改 `restriction.key`、
// 不改证据等级。原因不能猜：会员、付费音乐包、地区、下架只有受控对照验证过的规则才能说（在
// `PLAYBACK_HINT_RULES` 里加），其他一律是「原因尚未确认」；要试听却没有可用的试听文件时是「试听不可用」，带会话确认没有试听文件时是「没有试听」。文案是英文预设，前端可以按 key 换成自己的。
// 零依赖，两个运行时共用。

export type PlaybackHintKey =
  | 'playback.reason-unconfirmed'
  | 'playback.preview-unavailable'
  | 'playback.preview-missing'
  | 'playback.quality-file-unavailable'
  | 'playback.quality-detail-unavailable'
  | 'playback.maybe-region-restricted'
  | 'playback.maybe-music-pack'
  | 'playback.maybe-membership'
  | 'playback.maybe-taken-down';

export interface PlaybackHint {
  key: PlaybackHintKey;
  message: string;
}

export const PLAYBACK_HINT_MESSAGES: Readonly<Record<PlaybackHintKey, string>> = {
  'playback.quality-file-unavailable': 'No audio file is available for this quality.',
  'playback.quality-detail-unavailable':
    'This quality could not be checked. Please try again later.',
  'playback.reason-unconfirmed':
    "This song can't be played right now. The exact reason isn't confirmed yet.",
  'playback.preview-unavailable':
    "A preview isn't available for this song, or the reason isn't confirmed yet.",
  'playback.preview-missing': 'This song has no preview.',
  'playback.maybe-region-restricted': 'This song may not be available in your region.',
  'playback.maybe-music-pack': 'This song may need a paid music pack to play.',
  'playback.maybe-membership': 'This song may need a VIP membership to play in full.',
  'playback.maybe-taken-down': "This song can't be played right now. It may have been taken down.",
};

/** 一条验证过的规则：`trackInfo` 是同一个会话读到的单曲详情（`track_info`），读不到时是 `undefined`。 */
export interface PlaybackHintContext {
  authenticated: boolean;
  quality: string;
  codes: { result?: number; subcode?: number };
}

export interface PlaybackHintRule {
  key: Exclude<
    PlaybackHintKey,
    'playback.reason-unconfirmed' | 'playback.preview-unavailable' | 'playback.preview-missing'
  >;
  matches: (trackInfo: unknown, context?: PlaybackHintContext) => boolean;
}

/**
 * 单一手机 QQ 免费账号、同会话出口及权益受控重复实验的候选。微信同特征可复用提示，但尚未实测。
 * 只认完整数值组合，不扩展位元含义；不是结构化授权分类。其他特征保持未知。
 */
const read = (value: unknown, key: string): unknown =>
  value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
const integer = (value: unknown): number | undefined => {
  const parsed = typeof value === 'string' && /^\d{1,15}$/.test(value) ? Number(value) : value;
  return typeof parsed === 'number' && Number.isSafeInteger(parsed) ? parsed : undefined;
};
const tupleOf = (track: unknown): string => {
  const action = read(track, 'action');
  return [
    read(action, 'switch'),
    read(action, 'msgid'),
    read(action, 'alert'),
    read(read(track, 'pay'), 'pay_play'),
  ]
    .map(integer)
    .join('/');
};
/**
 * 能不能去查详情找原因。`subcode` 不是原因码：实测它只跟着文件名段数走（两段一律 1、一段一律 0，成功失败都一样）。
 * 这里要求 1，是确认这条回应和我们送的两段文件名对得上；回应不完整（例如没带 subcode）就不查，保持「原因尚未确认」。
 */
export const canLookupPlaybackHint = (context: PlaybackHintContext): boolean =>
  context.authenticated &&
  ['m4a', '128'].includes(context.quality) &&
  context.codes.result === 104003 &&
  context.codes.subcode === 1;
const REGION_TUPLES = ['1/23/0/0', '769/0/35/0', '769/0/35/1'];

/**
 * `action.switch` 的 bit 27（`0x8000000`）。2026-11 对照：官方 App（海外、登录）播放时与队列批次、大陆匿名
 * 详情三种视角里，带这一位的歌官方各端都放不了（下架，多数只剩 MV）；可播的歌都没有这一位。只认这一位，
 * 不推论其他位元。`switch 65537`（同样放不了，但没有这一位）不算在内，仍是原因尚未确认。
 */
const TAKEN_DOWN_SWITCH_BIT = 0x8000000;
const hasTakenDownBit = (track: unknown): boolean => {
  const value = integer(read(read(track, 'action'), 'switch'));
  return value !== undefined && value >= 0 && Math.floor(value / TAKEN_DOWN_SWITCH_BIT) % 2 === 1;
};
const MEMBERSHIP_TUPLES = [`${0x101d701}/13/21/1`, `${0x101d701}/13/41/1`, `${0x1019701}/13/41/1`];
export const PLAYBACK_HINT_RULES: readonly PlaybackHintRule[] = [
  {
    key: 'playback.maybe-region-restricted',
    matches: (track, context) =>
      Boolean(context && canLookupPlaybackHint(context) && REGION_TUPLES.includes(tupleOf(track))),
  },
  {
    key: 'playback.maybe-membership',
    matches: (track, context) =>
      Boolean(
        context && canLookupPlaybackHint(context) && MEMBERSHIP_TUPLES.includes(tupleOf(track)),
      ),
  },
  {
    key: 'playback.maybe-taken-down',
    matches: (track, context) =>
      Boolean(context && canLookupPlaybackHint(context) && hasTakenDownBit(track)),
  },
];

/** 条目本身带着上面几条规则认得的特征（不看取链结果）；挑替代版本时用来先跳过。 */
export const hasKnownUnplayableTraits = (track: unknown): boolean => {
  try {
    const tuple = tupleOf(track);
    return (
      REGION_TUPLES.includes(tuple) || MEMBERSHIP_TUPLES.includes(tuple) || hasTakenDownBit(track)
    );
  } catch {
    return false;
  }
};

const hint = (key: PlaybackHintKey): PlaybackHint => ({
  key,
  message: PLAYBACK_HINT_MESSAGES[key],
});

const matches = (
  rule: PlaybackHintRule,
  trackInfo: unknown,
  context?: PlaybackHintContext,
): boolean => {
  try {
    return rule.matches(trackInfo, context);
  } catch {
    return false;
  }
};

export const playbackHintOf = (
  trackInfo: unknown,
  rules: readonly PlaybackHintRule[] = PLAYBACK_HINT_RULES,
  context?: PlaybackHintContext,
): PlaybackHint => {
  const rule = rules.find((candidate) => matches(candidate, trackInfo, context));
  return hint(rule?.key ?? 'playback.reason-unconfirmed');
};

/** 要试听却没有可用的试听文件（或要了也没给链接）时的那一句。 */
export const previewUnavailableHint = (): PlaybackHint => hint('playback.preview-unavailable');

/** 同一会话读到的详情可靠、`size_try` 正好是 0：确定这首没有试听文件。 */
export const previewMissingHint = (): PlaybackHint => hint('playback.preview-missing');
