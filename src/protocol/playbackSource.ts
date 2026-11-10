// src/protocol/playbackSource.ts
//
// 一首歌取到（或没取到）的音源，在内部怎么描述。对外的 `playUrl` 回包形状不变，这份描述先只在内部用。
// 「完整」「试听」「不确定」分开记；取到链接、选好 CDN、确认音频真的能播是三件事，也分开记。
// 不知道的就留空，不拿别的字段推算。零依赖，两个运行时共用。

import type { EvidenceLevel } from './evidence';
import type { PlaybackEntryCodes } from './playbackDiagnostics';
import type { PlaybackQuality } from './playbackRestriction';

/** 取播放链接的几种办法。 */
export type PlaybackProtocolId =
  /** 带会话、安卓客户端身份，要未加密的完整文件。当前的主路径。 */
  | 'android-vkey'
  /** 同一个接口，要试听文件。 */
  | 'preview-rs02'
  /** 不带会话、匿名网页身份，只有 Node 上有。 */
  | 'web-anonymous-vkey'
  /** 官方手机客户端取加密文件用的接口。还没有实现，也没有可用的证据。 */
  | 'encrypted-evkey';

export type PlaybackProfileId = 'android' | 'web';

export interface PlaybackProtocolInfo {
  /** 上游的 module/method。 */
  rpc: string;
  profile: PlaybackProfileId;
  requiresSession: boolean;
  /** 要的是未加密文件、试听文件，还是要另外解密才能播的文件。 */
  files: 'plain' | 'preview' | 'encrypted';
  qualities: readonly (PlaybackQuality | 'preview')[];
  /** 这条路能不能拿到可播的链接，目前的证据到哪一级。 */
  evidence: EvidenceLevel;
  implemented: boolean;
  /** 一般请求会不会走到它。 */
  usedByDefault: boolean;
  /** 什么时候用、什么时候不该再试。 */
  notes: string;
}

export const PLAYBACK_PROTOCOLS: Readonly<Record<PlaybackProtocolId, PlaybackProtocolInfo>> = {
  'android-vkey': {
    rpc: 'music.vkey.GetVkey/UrlGetVkey',
    profile: 'android',
    requiresSession: true,
    files: 'plain',
    qualities: ['m4a', '128', '320', 'flac', 'ape'],
    evidence: 'verified-controlled',
    implemented: true,
    usedByDefault: true,
    notes:
      '带会话的请求都先走这里。文件名是两段：前缀、songmid、media_mid（没有就再放一次 songmid）。' +
      '登录失效、被限流时不再试；m4a、128 原因没确认时同一请求最多再取一次。',
  },
  'preview-rs02': {
    rpc: 'music.vkey.GetVkey/UrlGetVkey',
    profile: 'android',
    requiresSession: true,
    files: 'preview',
    qualities: ['preview'],
    evidence: 'verified-controlled',
    implemented: true,
    usedByDefault: false,
    notes:
      '调用方明确要试听（preview=1）才用。单曲详情确认有试听文件、又有 14 个字符的 media id 才去要，' +
      '不拿 songmid 代替。拿不到不再试。',
  },
  'web-anonymous-vkey': {
    rpc: 'vkey.GetVkeyServer/CgiGetVkey',
    profile: 'web',
    requiresSession: false,
    files: 'plain',
    qualities: ['m4a', '128', 'preview'],
    evidence: 'existing-behavior',
    implemented: true,
    usedByDefault: false,
    notes:
      '只有 Node 不带会话时用，Serverless 不带会话直接回 401。失败不再试，也不会改走带会话的路。',
  },
  'encrypted-evkey': {
    rpc: 'music.vkey.GetEVkey/CgiGetEVkey',
    profile: 'android',
    requiresSession: true,
    files: 'encrypted',
    qualities: [],
    evidence: 'protocol-reference',
    implemented: false,
    usedByDefault: false,
    notes:
      '官方手机客户端用它取加密文件和解密用的密钥，本项目没有实现，也不解密。' +
      '用它要未加密文件能不能成，没有同一首歌、同一账号、同一出口的对照，不能当成可用的备援。',
  },
};

/** `full` 完整歌曲，`preview` 试听片段，`unknown` 拿到了链接但没法确认是哪一种。 */
export type PlaybackSourceKind = 'full' | 'preview' | 'unknown';

/** 播放地址用的 CDN 是怎么定的。 */
export type PlaybackCdnStatus =
  /** 取链接的回应自己带的地址，没有另外探测。 */
  | 'response-sip'
  /** 探测过，这个地址回了内容。 */
  | 'probed'
  /** 探测都没通，或没法探测，用的是默认地址。 */
  | 'unverified-default'
  /** 没有链接，谈不上 CDN。 */
  | 'none';

export interface PlaybackSource {
  songmid: string;
  /** 文件名里用到的 media id；没有可信的值就不填。 */
  mediaMid?: string;
  kind: PlaybackSourceKind;
  /** 调用方要的音质，原样记下（可能是 best）。 */
  requestedQuality: string;
  /** 这次实际要的是哪一种文件；没取到链接也照记。 */
  attemptedQuality: PlaybackQuality | 'preview';
  protocol: PlaybackProtocolId;
  profile: PlaybackProfileId;
  /** 没有链接时是空字符串。 */
  url: string;
  /** 上游回应里的有效秒数；回应没给就不填，不自己估。 */
  upstreamExpirationSeconds?: number;
  /** 单曲详情写的整首歌长度；这次请求没读详情就不填。 */
  declaredDurationMs?: number;
  /** 实际能播多长：要真的读过音频才知道，目前没有任何一条路会填。 */
  playableDurationMs?: number;
  /** 试听片段在原曲里的起止位置：没有可靠来源，目前不填，也不拿别的字段推算。 */
  previewStartMs?: number;
  previewEndMs?: number;
  /** 上游有没有给这首歌的链接。 */
  granted: boolean;
  cdn: PlaybackCdnStatus;
  /** 音频本身有没有验过。现在一律没有。 */
  audioVerified: false;
  /** 这首歌在取链接回应里的数字，原样留着。 */
  codes: PlaybackEntryCodes;
}

/**
 * 拿到链接的条目算哪一种：明确要的试听就是试听；完整文件那条路上，这一条没有带失败的结果码才算完整，
 * 带着非零结果码却又有链接的，不确定是什么，记成 unknown。
 */
export const playbackSourceKindOf = (
  protocol: PlaybackProtocolId,
  codes: PlaybackEntryCodes,
): PlaybackSourceKind => {
  if (protocol === 'preview-rs02') return 'preview';
  return codes.result === undefined || codes.result === 0 ? 'full' : 'unknown';
};

/** 对外的成功条目。字段和以前一样：完整链接只有 url 和 error，试听多一个 preview。 */
export const publicPlayEntryOf = (
  source: PlaybackSource,
): { url: string; error: false; preview?: true } => ({
  url: source.url,
  error: false,
  ...(source.protocol === 'preview-rs02' ? { preview: true as const } : {}),
});
