import { type Dictionary } from '../../util/values';
import type { UserPlaylistOptions } from '../user/userPlaylistResponse';
import { type AndroidDevice } from './androidDevice';
import {
  type AuthenticatedSongListDetailOptions,
  type OwnedPlaylistSongsParams,
} from './authenticatedReads';
import { type DeviceContextRepository } from './deviceContextStore';
import type { AuthHttpClient } from './httpClient';
import { type StreamUrlProbe } from './streamCdnSelector';

// src/services/auth/qrTypes.ts
// 从认证入口搬出的同一套实现；协议、状态与对外回包沿用原规则。

/**
 * Login channels. `qq` is the mobile QQ QR (MQTT over WSS, `tmeLoginType: 6`) and stays the
 * default so the public contract is unchanged for callers that do not ask for a channel; `wechat`
 * is the WeChat QR. `qqmusic` is the QQ Music app QR: the same QR and MQTT flow as `qq`, but the
 * exchange follows the account type the app reports, so an app signed in with a WeChat account can
 * log in too. `SUPPORTED_LOGIN_CHANNELS` is the authority on the product surface.
 */
export type QrLoginChannel = 'qq' | 'wechat' | 'qqmusic';

/** The channels whose QR is created by `CreateQRCode` and answered over MQTT. */
export const isMqttLoginChannel = (channel: QrLoginChannel | undefined): boolean =>
  channel === 'qq' || channel === 'qqmusic';

/**
 * `mobile` is the former name of `qq`. It is still accepted at the entry points and normalized to
 * the canonical value right there, so nothing downstream ever sees it, and it is deliberately kept
 * out of `SUPPORTED_LOGIN_CHANNELS`: an alias must not become a third channel in a client's UI.
 */
export type LegacyQrLoginChannel = 'mobile';

export const DEFAULT_LOGIN_CHANNEL: QrLoginChannel = 'qq';

/** Exported alongside `QrSessionRecord`: a serialized record cannot be typed without it. */
export type QrState =
  | 'created'
  | 'creating'
  | 'waiting'
  | 'scanned'
  | 'exchanging'
  | 'confirmed'
  | 'expired'
  | 'failed';

/**
 * What a runtime can actually serve. The Node entry point keeps declaring both channels and the
 * process-local session store; a serverless runtime declares the subset it can honour, so the
 * front end never offers a channel that is guaranteed to fail.
 */
export interface RuntimeCapabilities {
  readonly channels: readonly QrLoginChannel[];
  readonly sessionMode: 'stored' | 'sealed';
}

export const NODE_RUNTIME_CAPABILITIES: RuntimeCapabilities = {
  // `qqmusic` goes last: a client that lists channels in order keeps showing the existing two first.
  channels: ['qq', 'wechat', 'qqmusic'],
  sessionMode: 'stored',
};

/** The channels the Node entry point routes; unchanged, now derived from its capabilities. */
export const SUPPORTED_LOGIN_CHANNELS: readonly QrLoginChannel[] =
  NODE_RUNTIME_CAPABILITIES.channels;

export const isSupportedLoginChannel = (value: unknown): value is QrLoginChannel =>
  SUPPORTED_LOGIN_CHANNELS.includes(value as QrLoginChannel);

export const LEGACY_LOGIN_CHANNEL_ALIASES = new Map<string, QrLoginChannel>([['mobile', 'qq']]);

/** Accepts a canonical channel or a legacy alias and answers with the canonical value. */
export const normalizeLoginChannel = (value: unknown): QrLoginChannel | undefined => {
  if (isSupportedLoginChannel(value)) return value;
  return typeof value === 'string' ? LEGACY_LOGIN_CHANNEL_ALIASES.get(value) : undefined;
};

export interface QqCredential extends Dictionary {
  musicid: string | number;
  musickey: string;
  loginType: number;
}

export interface QrEvent {
  type: string | null;
  payload: unknown;
}

export interface QrEventListener {
  ready: Promise<void>;
  done: Promise<void>;
  close(): void;
}

/**
 * The serializable half of a QR session. Everything a runtime has to carry across a request
 * boundary lives here; the live socket and cookie jar stay in `QrSessionRuntime`, which is
 * process-local by nature and can never be persisted or sealed.
 */
export interface QrSessionRecord extends QrFailureDetails {
  key: string;
  channel: QrLoginChannel;
  state: QrState;
  createdAt: number;
  expiresAt: number;
  /** Channel-agnostic QR handle: the App `qrcodeID`, or the WeChat `uuid`. */
  identifier?: string;
  /** App channel only; kept as-is because it is the `qrCodeID` exchange parameter. */
  qrcodeId?: string;
  imageUrl?: string;
  authToken?: string;
  retryAfterMs?: number;
}

export type QrFailureStage =
  | 'qr-key'
  | 'device-bootstrap'
  | 'session-bootstrap'
  | 'qr-create'
  | 'mqtt-listener'
  | 'qr-poll'
  | 'qr-event'
  | 'credential-payload'
  | 'credential-exchange'
  | 'credential-validation'
  | 'session-issue';

export type QrFailureReason =
  | 'local-backoff'
  | 'session-busy'
  | 'upstream-http-error'
  | 'upstream-rejected'
  | 'mqtt-websocket-error'
  | 'mqtt-websocket-closed'
  | 'mqtt-packet-timeout'
  | 'mqtt-handshake-timeout'
  | 'mqtt-handshake-failed'
  | 'missing-credential'
  | 'network-timeout'
  | 'dns-error'
  | 'connection-reset'
  | 'connection-refused'
  | 'network-error'
  | 'login-rejected'
  | 'user-canceled'
  | 'qr-timeout'
  | 'unexpected-error';

/** The step a fallback ran after, kept because the fallback's own result replaces it on top. */
export interface QrPrimaryFailure {
  failureStage?: QrFailureStage;
  failureReason?: QrFailureReason;
  upstreamCode?: number;
  upstreamErrorKey?: string;
}

/** Safe failure metadata shared by QR checks and startup errors. */
export interface QrFailureDetails {
  failureStage?: QrFailureStage;
  failureReason?: QrFailureReason;
  upstreamHttpStatus?: number;
  upstreamCode?: number;
  upstreamGlobalCode?: number;
  upstreamSubCode?: number;
  /** Only for a code registered with a source for this channel and step; unknown codes get none. */
  upstreamErrorKey?: string;
  /** Present only when a fallback ran: what the first attempt failed with. */
  primaryFailure?: QrPrimaryFailure;
  /** Present (and `true`) only when a fallback ran after the primary step failed. */
  fallbackAttempted?: true;
  /** A plain-English hint for people, derived from the fields above; only for recognised failures. */
  failureHint?: { key: string; message: string };
}

export interface QrFailureDiagnostics extends QrFailureDetails {
  /** Origin of the current service's cooldown; absent after process restart. */
  lastFailure?: QrFailureDetails;
}

/**
 * Process-local handles for one QR session. They die with the process, which is exactly why they
 * are kept out of `QrSessionRecord`.
 */
export interface QrSessionRuntime {
  driver: QrChannelDriver;
  listener?: QrEventListener;
  /**
   * Web login channels hop across weixin.qq.com / qq.com carrying cookies. Sharing the musicu
   * jar would cross-contaminate both, so those channels get a client per QR session that dies
   * with the session. The App channel keeps using the shared client.
   */
  http?: AuthHttpClient;
  /** Consecutive `advance()` failures tolerated before the session is failed. */
  pollErrors: number;
  /** The in-flight credential exchange, so a pull channel can await it before answering. */
  finalizing?: Promise<void>;
  /** 这次 check 必须回答的时间点；自己换凭证的通道用它给换凭证设时限。 */
  deadlineAt?: number;
}

/** Same contract as `AuthSessionRepository`, for the pre-login half of the state. */
export interface QrSessionRepository {
  readonly kind: string;
  load(): unknown;
  save(sessions: readonly QrSessionRecord[]): void;
}

export interface QrCodeMaterial {
  identifier: string;
  imageUrl: string;
  expiresIn?: number;
}

export interface QrDriverContext {
  /** Push drivers deliver events here the moment they arrive, exactly as the MQTT listener does. */
  onEvent(event: QrEvent): void;
  /** Remaining QR lifetime, used as the background listener's own deadline. */
  timeoutMs: number;
}

/**
 * The QR event source, per channel.
 *
 * `push` drivers own a background connection and report through `QrDriverContext.onEvent`, which
 * is what keeps the MQTT channel's timing identical to the self-driving listener it replaces.
 * `pull` drivers own nothing between calls: each `advance()` performs one time-boxed observation
 * of the upstream, which is the only shape a serverless invocation can support.
 */
export interface QrChannelDriver {
  readonly mode: 'push' | 'pull';
  createQr(session: QrSessionRecord, signal?: AbortSignal): Promise<QrCodeMaterial>;
  /** Push drivers only: starts the event source once the record is final. */
  start?(session: QrSessionRecord, context: QrDriverContext): QrEventListener;
  advance(session: QrSessionRecord, budgetMs: number, signal?: AbortSignal): Promise<QrEvent[]>;
  /**
   * 自己换凭证的通道才有：`authorized` 事件之后由服务调用，`signal` 是这次 check 剩下的时间。
   * 没有这个方法的通道照原来的规则换凭证。
   */
  exchange?(
    session: QrSessionRecord,
    payload: unknown,
    signal?: AbortSignal,
  ): Promise<QqCredential>;
  close(session: QrSessionRecord): void;
}

/**
 * Complete server-side login state behind the opaque `qqmusic_session` token.
 *
 * This type is exported only so an embedding host can persist it through the repository contract
 * below. It must never be returned by an HTTP endpoint or copied into renderer storage: in Folia,
 * only the opaque `token` crosses into the renderer process.
 */
export interface AuthSession {
  token: string;
  credential: QqCredential;
  device: AndroidDevice;
  expiresAt: number;
}

/**
 * Synchronous by design: Electron's `safeStorage` API and the existing login service are both
 * synchronous at this boundary. Keeping persistence outside this package lets desktop hosts
 * encrypt credentials with the OS keychain while ordinary server deployments retain the safe,
 * process-local default.
 *
 * `load` returns `unknown` intentionally. Persisted state is an untrusted input and is validated
 * before any credential reaches an upstream request.
 */
export interface AuthSessionRepository {
  readonly kind: string;
  load(): unknown;
  save(sessions: readonly AuthSession[]): void;
}

/**
 * How a login token is turned into an `AuthSession` and back. `stored` keeps the credential on the
 * server and hands out an opaque lookup key — the permanent default for Node, Electron and Docker.
 * `sealed` carries the credential inside the token itself, for runtimes that have nowhere to keep
 * process state.
 *
 * 🔴 The two modes differ in one externally visible way: `revoke()` deletes precisely under
 * `stored`, but a sealed token is only invalidated by the client discarding it, so `revoke()` is a
 * no-op there and the session remains usable until `expiresAt`. This is why `mode` is on the port.
 *
 * `cleanup` and `useRepository` are the two lifecycle hooks the stored backend needs and the sealed
 * backend has no use for: sealed expiry lives inside the token and is checked on `resolve`, and
 * there is no repository to swap. They are optional so a resolver can omit both.
 */
export interface SessionResolver {
  readonly mode: 'stored' | 'sealed';
  issue(session: Omit<AuthSession, 'token'>): Promise<string>;
  resolve(token: string | undefined): Promise<AuthSession | null>;
  lookup?(token: string | undefined): Promise<AuthSession | null>;
  resolveForPlayback?(
    token: string,
    options: {
      signal: AbortSignal;
      reserve: () => void;
      refresh: (session: AuthSession, signal: AbortSignal) => Promise<QqCredential>;
    },
  ): Promise<AuthSession | null>;
  revoke(token: string): Promise<void>;
  cleanup?(): void;
  useRepository?(repository: AuthSessionRepository): void;
  /**
   * Sealed only: renew a nearly expired credential and hand out a new token. `null` means the token
   * does not resolve at all. Stored has no use for it — its silent refresh keeps the same token.
   */
  rotate?(
    token: string,
    refresh: (session: AuthSession) => Promise<QqCredential>,
  ): Promise<SessionRotation | null>;
}

/** What `POST /login/refresh` answers: the token to keep using, and whether it changed. */
export interface SessionRotation {
  token: string;
  expiresAt: number;
  rotated: boolean;
}

export interface QrLoginDependencies {
  /** 全局停用具体播放提示；不改变播放、授权或重试。默认启用。 */
  playbackHintsEnabled?: boolean;
  /** 拿不到链接时换办法再试（见 playbackFallback）。默认关；目前也没有登记的候选。 */
  playbackFallbackEnabled?: boolean;
  http?: AuthHttpClient;
  streamUrlProbe?: StreamUrlProbe;
  /** Builds the per-QR-session client used by the web login channels. */
  createSessionHttp?: () => AuthHttpClient;
  deviceRepository?: DeviceContextRepository;
  authSessionRepository?: AuthSessionRepository;
  /** Replaces the whole token strategy. Defaults to the stored resolver over `authSessionRepository`. */
  sessionResolver?: SessionResolver;
  qrSessionRepository?: QrSessionRepository;
  listen?: (
    qrcodeId: string,
    onEvent: (event: QrEvent) => void,
    timeoutMs: number,
  ) => QrEventListener;
  /** Replaces a channel's event source; the Node defaults are built from `listen` and `http`. */
  drivers?: Partial<Record<QrLoginChannel, QrChannelDriver>>;
  capabilities?: RuntimeCapabilities;
  /**
   * How long one `/login/qr/check` may observe a pull channel before answering. The Node default
   * (15 s, `QQ_WECHAT_POLL_BUDGET_MS`) lets a slow link finish its handshake and still read the
   * scan; a state change answers at once, so only idle checks get longer. A serverless runtime sets
   * its own budget so a single invocation can absorb a long poll.
   */
  checkBudgetMs?: number;
  now?: () => number;
  randomBytes?: (size: number) => Buffer;
}

/** `preview`: ask for the preview file (`RS02…mp3`) instead of the chosen quality. */
export interface PlaybackOptions {
  preview?: boolean;
}

export interface QrCheckResult extends QrFailureDetails {
  code: 800 | 801 | 802 | 803;
  message: string;
  cookie?: string;
  retryAfterMs?: number;
}

export interface QrLoginService {
  getEncryptedMusicPlay(
    auth: AuthSession,
    songmid: string,
    quality: import('../../protocol/playbackFiles').EncryptedPlaybackQuality,
  ): Promise<Dictionary>;
  lookupSession(token?: string): Promise<AuthSession | null>;
  getEncryptedMusicPlayWithinBudget(
    token: string,
    songmid: string,
    quality: import('../../protocol/playbackFiles').EncryptedPlaybackQuality,
    signal?: AbortSignal,
  ): Promise<Dictionary | null>;
  getCapabilities(): RuntimeCapabilities;
  createSession(channel?: QrLoginChannel | LegacyQrLoginChannel): Promise<string>;
  createQr(key: string): Promise<string>;
  /** Async since M1: a pull channel observes its upstream inside this call. */
  checkQr(key: string, budgetMs?: number): Promise<QrCheckResult>;
  cancelSession(key: string): void;
  getLoginStatus(token?: string): Promise<Dictionary | null>;
  getUserDetail(token?: string): Promise<Dictionary | null>;
  getUserPlaylists(
    token?: string,
    uin?: string,
    options?: UserPlaylistOptions,
  ): Promise<Dictionary | null>;
  getUserAlbums(token?: string, offset?: number, limit?: number): Promise<Dictionary | null>;
  getUserLikedSongs(token?: string, offset?: number, limit?: number): Promise<Dictionary | null>;
  getOwnedPlaylistSongs(
    token?: string,
    params?: OwnedPlaylistSongsParams,
  ): Promise<Dictionary | null>;
  /**
   * 带凭据读一张歌单。匿名 CGI 读不到的算法歌单（百万收藏、歌手漫游……）靠它；没有会话、或
   * `disstid` 不是正整数时返回 `null`。
   */
  getAuthenticatedSongListDetail(
    token?: string,
    disstid?: number | string,
    options?: AuthenticatedSongListDetailOptions,
  ): Promise<Dictionary | null>;
  getMusicPlay(
    token: string | undefined,
    songmid: string,
    quality?: string | number,
    mediaId?: string,
    options?: PlaybackOptions,
  ): Promise<Dictionary | null>;
  /** 新路由用：解析会话并交给共用实现建自己的上游客户端。解不开、过期都返回 `null`。 */
  resolveSession(token?: string): Promise<AuthSession | null>;
  /** The explicit renewal behind `POST /login/refresh`; `null` when the token is not logged in. */
  refreshSession(token?: string): Promise<SessionRotation | null>;
  configureAuthSessionRepository(repository: AuthSessionRepository): void;
  logout(token?: string): Promise<void>;
}

export type QrListenerFactory = (
  qrcodeId: string,
  onEvent: (event: QrEvent) => void,
  timeoutMs: number,
) => QrEventListener;
