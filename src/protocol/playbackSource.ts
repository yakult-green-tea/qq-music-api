// src/protocol/playbackSource.ts
//
// 一首歌取到（或没取到）的音源，在内部怎么描述。对外的 `playUrl` 回包形状不变，只多一个可选的 `source`，
// 里面只放几项（见 publicSourceOf），其余只在内部用。
// 「完整」「试听」「不确定」分开记；文件格式、加密、授权结果、能不能直接播、试听范围也各记各的。
// 不知道的就留空，不拿别的字段推算。零依赖，两个运行时共用。

import type { ClientProfileId } from './clientProfiles';
import type { EvidenceLevel } from './evidence';
import type { PlaybackEntryCodes } from './playbackDiagnostics';
import type { EncryptedPlaybackQuality, PlaybackCodec, PlaybackFileInfo } from './playbackFiles';
import type { PlaybackQuality } from './playbackRestriction';

/** 取播放链接的几种办法。 */
export type PlaybackProtocolId =
  /** 带会话、安卓客户端身份，要未加密的完整文件。当前的主路径。 */
  | 'android-vkey'
  /** 同一个接口，要试听文件。 */
  | 'preview-rs02'
  /** 不带会话、匿名网页身份，只有 Node 上有。 */
  | 'web-anonymous-vkey'
  /** 用取加密文件的接口要未加密文件。只登记：实测在两个海外出口都没有比现行做法多拿到歌。 */
  | 'evkey-plain'
  /** 调用方明确要加密文件时才用。 */
  | 'encrypted-evkey';

export type PlaybackProfileId = ClientProfileId;

export interface PlaybackProtocolInfo {
  /** 上游的 module/method。 */
  rpc: string;
  profile: PlaybackProfileId;
  requiresSession: boolean;
  /** 要的是未加密文件、试听文件，还是要另外解密才能播的文件。 */
  files: 'plain' | 'preview' | 'encrypted';
  qualities: readonly (PlaybackQuality | EncryptedPlaybackQuality | 'preview')[];
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
  'evkey-plain': {
    rpc: 'music.vkey.GetEVkey/CgiGetEVkey',
    profile: 'android',
    requiresSession: true,
    files: 'plain',
    qualities: [],
    evidence: 'observed-response',
    implemented: false,
    usedByDefault: false,
    notes:
      '同一首歌、同一账号只换出口的对照里，现行做法被挡的歌换成这里（含 ct=24、一段文件名等组合）也一样被挡；' +
      '另有一种账号在这里一律被拒。没有证据能多拿到歌，不当备援。',
  },
  'encrypted-evkey': {
    rpc: 'music.vkey.GetEVkey/CgiGetEVkey',
    profile: 'android',
    requiresSession: true,
    files: 'encrypted',
    qualities: ['96', '192', 'flac'],
    evidence: 'verified-controlled',
    implemented: true,
    usedByDefault: false,
    notes: '只在独立的加密取链接接口使用。返回加密文件链接和对应字段，不解密。',
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

/**
 * 这一次取链接的授权结果：`full` 给了完整文件、`preview` 给了试听文件、`refused` 没给链接、
 * `unknown` 给了链接却带着失败的结果码。只说这一次，不代表账号对这首歌的整体权益。
 */
export type PlaybackAccess = 'full' | 'preview' | 'refused' | 'unknown';

/**
 * 能不能直接播：`direct` 有链接、格式不用解密、CDN 是回应给的或探测过的；`cdn-unverified` 有链接但 CDN 是
 * 没验过的默认地址；`unsupported-encrypted` 要解密才能播（本项目不做）；`unplayable` 没有链接。
 * 都不代表音频真的读过（见 audioVerified）。
 */
export type PlaybackPlayability =
  | 'direct'
  | 'cdn-unverified'
  | 'unsupported-encrypted'
  | 'unplayable';

/**
 * 试听：长度和片段在原曲里的位置分开记来源。`upstream-declared` 是单曲详情写的，`measured` 是实际比对过的，
 * `unknown` 是不知道。位置没有可靠来源时不填，不默认 0。
 */
export interface PlaybackTrial {
  durationMs?: number;
  durationSource: 'upstream-declared' | 'measured' | 'unknown';
  startMs?: number;
  endMs?: number;
  rangeSource: 'measured' | 'upstream-declared' | 'unknown';
}

export interface PlaybackSource {
  songmid: string;
  /** 文件名里用到的 media id；没有可信的值就不填。 */
  mediaMid?: string;
  kind: PlaybackSourceKind;
  /** 调用方要的音质，原样记下（可能是 best）。 */
  requestedQuality: string;
  /** 这次实际要的是哪一种文件；没取到链接也照记。 */
  attemptedQuality: PlaybackQuality | EncryptedPlaybackQuality | 'preview';
  /** 上游给的文件名是哪一种音质；认不出就不填，不拿要的音质顶上。 */
  deliveredQuality?: PlaybackFileInfo['quality'] | EncryptedPlaybackQuality;
  /** 文件格式，从上游给的文件名推出来的；认不出不填。 */
  codec?: PlaybackCodec;
  /** 有没有加密，同样从文件名推；认不出不填。 */
  encryption?: 'none' | 'encrypted';
  protocol: PlaybackProtocolId;
  /** 用的是哪一种客户端身份，以及实际送的 ct／cv。 */
  deviceProfile: PlaybackProfileId;
  client: { ct: number; cv: number | string };
  /** 没有链接时是空字符串。 */
  url: string;
  /** 上游回应里的有效秒数；回应没给就不填，不自己估。 */
  upstreamExpirationSeconds?: number;
  /** 单曲详情写的整首歌长度；这次请求没读详情就不填。 */
  declaredDurationMs?: number;
  /** 实际能播多长：要真的读过音频才知道，目前没有任何一条路会填。 */
  playableDurationMs?: number;
  /** 只有试听文件才有；长度来源不明、也没有位置时整个不填。 */
  trial?: PlaybackTrial;
  /** 上游有没有给这首歌的链接。 */
  granted: boolean;
  cdn: PlaybackCdnStatus;
  access: PlaybackAccess;
  playability: PlaybackPlayability;
  /** 音频本身有没有验过。现在一律没有。 */
  audioVerified: false;
  /** 这首歌在取链接回应里的数字，原样留着（失败原因只看 restriction，不从 subcode 推）。 */
  codes: PlaybackEntryCodes;
}

type AccessInput = Pick<PlaybackSource, 'granted' | 'kind'>;
type PlayabilityInput = Pick<PlaybackSource, 'granted' | 'cdn' | 'encryption'>;

export const playbackAccessOf = ({ granted, kind }: AccessInput): PlaybackAccess =>
  granted ? kind : 'refused';

export const playbackPlayabilityOf = ({
  granted,
  cdn,
  encryption,
}: PlayabilityInput): PlaybackPlayability => {
  if (!granted) return 'unplayable';
  if (encryption === 'encrypted') return 'unsupported-encrypted';
  return cdn === 'unverified-default' ? 'cdn-unverified' : 'direct';
};

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

/**
 * 对外条目上可选的 `source`：旧的调用方不认识它也没关系，原有字段都不变。
 * `quality`、`codec` 只在认出上游给的文件名时才有；`trial` 只在试听文件、而且知道长度时才有，
 * 只交长度，片段在原曲里的位置先不交。
 */
export interface PublicPlaybackSource {
  kind: PlaybackSourceKind;
  protocol: PlaybackProtocolId;
  cdn: PlaybackCdnStatus;
  quality?: PlaybackSource['deliveredQuality'];
  codec?: PlaybackCodec;
  trial?: { durationMs: number };
}

export const publicSourceOf = (source: PlaybackSource): PublicPlaybackSource => ({
  kind: source.kind,
  protocol: source.protocol,
  cdn: source.cdn,
  ...(source.deliveredQuality ? { quality: source.deliveredQuality } : {}),
  ...(source.codec ? { codec: source.codec } : {}),
  ...(source.trial?.durationMs !== undefined
    ? { trial: { durationMs: source.trial.durationMs } }
    : {}),
});

/** 对外的成功条目：url、error 和以前一样，试听多一个 preview，最后是可选的 source。 */
export const publicPlayEntryOf = (
  source: PlaybackSource,
): { url: string; error: false; preview?: true; source: PublicPlaybackSource } => ({
  url: source.url,
  error: false,
  ...(source.protocol === 'preview-rs02' ? { preview: true as const } : {}),
  source: publicSourceOf(source),
});
