import crypto from 'node:crypto';
import { AuthCredentialRejectedError } from '../../util/authError';
import { logger } from '../../util/logger';
import {
  type AndroidDevice,
  buildAndroidComm,
  buildQimeiRequest,
  credentialMusicId,
  isAndroidDevice,
  QIMEI_URL,
  randomDigits,
} from './androidDevice';
import {
  createDefaultDeviceContextRepository,
  createDeviceContextStore,
  type DeviceContextRepository,
  type DeviceContextStore,
} from './deviceContext';
import createAuthHttpClient, { type AuthHttpClient } from './httpClient';
import {
  type Dictionary,
  dictionaryOf,
  identifierOf,
  isAbortError,
  isDictionary,
  numberOf,
  parseDictionary,
  stringOf,
} from './values';
import {
  createWechatQr,
  eventForWechatStatus,
  MAX_CONSECUTIVE_POLL_ERRORS,
  pollWechatQr,
  WECHAT_APP_ID,
  WECHAT_DEFAULT_POLL_BUDGET_MS,
  WECHAT_LOGIN_TYPE,
  WechatQrError,
} from './wechatLogin';

const WebSocketRuntime = require('ws') as WebSocketConstructor;

// The QIMEI bootstrap request construction and the synthetic device material now live in
// `androidDevice.ts`; both are re-exported so existing importers keep their entry point.
export { buildAndroidComm, buildQimeiRequest } from './androidDevice';

const MUSICU_URL = 'https://u.y.qq.com/cgi-bin/musicu.fcg';
const MQTT_HOST = 'mu.y.qq.com';
const MQTT_INITIAL_PATH = '/ws/handshake';
const QR_TTL_MS = 3 * 60 * 1000;
/** 上游没有交代 musickey 寿命时的兜底会话时长，也是这个常量原本的唯一用途。 */
const AUTH_TTL_MS = 24 * 60 * 60 * 1000;
/** 推导出来的会话时长夹在这个区间内，挡住上游给出畸形时间时的两个极端。 */
const AUTH_TTL_MIN_MS = 60 * 60 * 1000;
const AUTH_TTL_MAX_MS = 7 * 24 * 60 * 60 * 1000;
const QIMEI_TTL_MS = 24 * 60 * 60 * 1000;
const BACKOFF_BASE_MS = 30 * 1000;
const BACKOFF_MAX_MS = 15 * 60 * 1000;

/**
 * Login channels. `qq` is the QQ Music App QR (MQTT over WSS, `tmeLoginType: 6`) and stays the
 * default so the public contract is unchanged for callers that do not ask for a channel; `wechat`
 * is the WeChat QR. These two are the whole product surface, and `SUPPORTED_LOGIN_CHANNELS` is the
 * authority on it.
 */
export type QrLoginChannel = 'qq' | 'wechat';
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
  channels: ['qq', 'wechat'],
  sessionMode: 'stored',
};

/** The channels the Node entry point routes; unchanged, now derived from its capabilities. */
export const SUPPORTED_LOGIN_CHANNELS: readonly QrLoginChannel[] =
  NODE_RUNTIME_CAPABILITIES.channels;

export const isSupportedLoginChannel = (value: unknown): value is QrLoginChannel =>
  SUPPORTED_LOGIN_CHANNELS.includes(value as QrLoginChannel);

const LEGACY_LOGIN_CHANNEL_ALIASES = new Map<string, QrLoginChannel>([['mobile', 'qq']]);

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
export interface QrSessionRecord {
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
  upstreamCode?: number;
  retryAfterMs?: number;
}

/**
 * Process-local handles for one QR session. They die with the process, which is exactly why they
 * are kept out of `QrSessionRecord`.
 */
interface QrSessionRuntime {
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
  revoke(token: string): Promise<void>;
  cleanup?(): void;
  useRepository?(repository: AuthSessionRepository): void;
}

interface QrLoginDependencies {
  http?: AuthHttpClient;
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
   * stays inside the client's existing 2 s poll cadence; a serverless runtime raises it so a
   * single invocation can absorb a long poll.
   */
  checkBudgetMs?: number;
  now?: () => number;
  randomBytes?: (size: number) => Buffer;
}

export interface QrCheckResult {
  code: 800 | 801 | 802 | 803;
  message: string;
  cookie?: string;
  upstreamCode?: number;
  retryAfterMs?: number;
}

export interface QrLoginService {
  getCapabilities(): RuntimeCapabilities;
  createSession(channel?: QrLoginChannel | LegacyQrLoginChannel): Promise<string>;
  createQr(key: string): Promise<string>;
  /** Async since M1: a pull channel observes its upstream inside this call. */
  checkQr(key: string, budgetMs?: number): Promise<QrCheckResult>;
  cancelSession(key: string): void;
  getLoginStatus(token?: string): Promise<Dictionary | null>;
  getUserDetail(token?: string): Promise<Dictionary | null>;
  getUserPlaylists(token?: string, uin?: string): Promise<Dictionary | null>;
  getUserAlbums(token?: string, offset?: number, limit?: number): Promise<Dictionary | null>;
  getUserLikedSongs(token?: string, offset?: number, limit?: number): Promise<Dictionary | null>;
  getMusicPlay(
    token: string | undefined,
    songmid: string,
    quality?: string | number,
    mediaId?: string,
  ): Promise<Dictionary | null>;
  configureAuthSessionRepository(repository: AuthSessionRepository): void;
  logout(token?: string): Promise<void>;
}

interface AuthSessionStore {
  get(token: string): AuthSession | null;
  set(session: AuthSession): void;
  delete(token: string): void;
  cleanup(): void;
  useRepository(repository: AuthSessionRepository): void;
}

const cloneAuthSession = (session: AuthSession): AuthSession => ({
  ...session,
  credential: { ...session.credential },
  device: { ...session.device },
});

const isQqCredential = (value: unknown): value is QqCredential => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const hasMusicId =
    (typeof candidate.musicid === 'string' && candidate.musicid.length > 0) ||
    (typeof candidate.musicid === 'number' && Number.isFinite(candidate.musicid));
  return (
    hasMusicId &&
    typeof candidate.musickey === 'string' &&
    candidate.musickey.length > 0 &&
    typeof candidate.loginType === 'number' &&
    Number.isFinite(candidate.loginType)
  );
};

/** A decrypted record is still untrusted: reject partial or hand-edited credentials on restore. */
export const isAuthSession = (value: unknown): value is AuthSession => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.token === 'string' &&
    candidate.token.length > 0 &&
    isQqCredential(candidate.credential) &&
    isAndroidDevice(candidate.device) &&
    typeof candidate.expiresAt === 'number' &&
    Number.isFinite(candidate.expiresAt)
  );
};

/**
 * Backwards-compatible default for servers that do not opt into persistence. The repository owns
 * copies so callers cannot mutate a stored credential through a previously returned object.
 */
export const createMemoryAuthSessionRepository = (
  seed: readonly AuthSession[] = [],
): AuthSessionRepository => {
  let stored = seed.filter(isAuthSession).map(cloneAuthSession);
  return {
    kind: 'memory',
    load: () => stored.map(cloneAuthSession),
    save: (sessions) => {
      stored = sessions.map(cloneAuthSession);
    },
  };
};

/**
 * Keeps repository failures outside the login protocol. A locked keychain or corrupt desktop state
 * must degrade to the previous in-memory behaviour instead of preventing QR login altogether.
 */
const createAuthSessionStore = (
  initialRepository: AuthSessionRepository,
  now: () => number,
): AuthSessionStore => {
  let repository = initialRepository;
  const sessions = new Map<string, AuthSession>();

  const persist = (): void => {
    try {
      repository.save(Array.from(sessions.values(), cloneAuthSession));
    } catch (error) {
      logger.warn('qq-auth.auth-session.save-failed', {
        kind: repository.kind,
        name: error instanceof Error ? error.name : 'Error',
      });
    }
  };

  const removeExpired = (): boolean => {
    let removed = false;
    const current = now();
    for (const [token, session] of sessions) {
      if (session.expiresAt <= current) {
        sessions.delete(token);
        removed = true;
      }
    }
    return removed;
  };

  const restore = (): void => {
    let loaded: unknown;
    try {
      loaded = repository.load();
    } catch (error) {
      logger.warn('qq-auth.auth-session.load-failed', {
        kind: repository.kind,
        name: error instanceof Error ? error.name : 'Error',
      });
      return;
    }

    if (loaded === null || loaded === undefined) loaded = [];
    if (!Array.isArray(loaded)) {
      logger.warn('qq-auth.auth-session.invalid-state', { kind: repository.kind });
      return;
    }

    let rejectedCount = 0;
    for (const value of loaded) {
      if (!isAuthSession(value)) {
        rejectedCount += 1;
        continue;
      }
      sessions.set(value.token, cloneAuthSession(value));
    }
    const expiredRemoved = removeExpired();
    logger.info('qq-auth.auth-session.ready', {
      kind: repository.kind,
      restoredCount: sessions.size,
      rejectedCount,
    });
    // Rewrite only when validation pruned records, so corrupt or expired credentials are not
    // repeatedly decrypted and examined on every application launch.
    if (rejectedCount > 0 || expiredRemoved) persist();
  };

  restore();

  return {
    get: (token) => sessions.get(token) ?? null,
    set: (session) => {
      sessions.set(session.token, cloneAuthSession(session));
      persist();
    },
    delete: (token) => {
      if (sessions.delete(token)) persist();
    },
    cleanup: () => {
      if (removeExpired()) persist();
    },
    useRepository: (nextRepository) => {
      // The npm package starts listening as a side effect of require(). Folia injects its encrypted
      // repository immediately afterwards; preserving any already-created in-memory entries also
      // makes a late-but-valid configuration call lossless.
      const currentSessions = Array.from(sessions.values(), cloneAuthSession);
      sessions.clear();
      repository = nextRepository;
      restore();
      for (const session of currentSessions) {
        if (session.expiresAt > now()) sessions.set(session.token, session);
      }
      if (currentSessions.length > 0) persist();
    },
  };
};

/**
 * The `stored` backend: a thin adapter over the existing `AuthSessionStore`, which is left exactly
 * as it was. Nothing here re-implements lookup, persistence, expiry or repository swapping — the
 * store still owns all of it, so the six PR #2 behaviour guarantees continue to be enforced by the
 * same code that has always enforced them.
 *
 * The only logic that moves in is minting the token, which `finalizeLogin` used to do inline: the
 * port hands `issue()` a session without one precisely so a sealed backend can derive the token
 * from the credential instead of generating an unrelated identifier.
 */
export const createStoredSessionResolver = (options: {
  repository: AuthSessionRepository;
  now: () => number;
  randomBytes: (size: number) => Buffer;
}): SessionResolver => {
  const store = createAuthSessionStore(options.repository, options.now);
  return {
    mode: 'stored',
    issue: async (session) => {
      const token = options.randomBytes(32).toString('hex');
      store.set({ ...session, token });
      return token;
    },
    resolve: async (token) => (token ? store.get(token) : null),
    revoke: async (token) => {
      store.delete(token);
    },
    cleanup: () => {
      store.cleanup();
    },
    useRepository: (repository) => {
      store.useRepository(repository);
    },
  };
};

const QR_STATES: readonly QrState[] = [
  'created',
  'creating',
  'waiting',
  'scanned',
  'exchanging',
  'confirmed',
  'expired',
  'failed',
];

/** A restored QR record is untrusted input, exactly like a restored auth session. */
export const isQrSessionRecord = (value: unknown): value is QrSessionRecord => {
  if (!isDictionary(value)) return false;
  const optionalText = (key: string): boolean =>
    value[key] === undefined ||
    (typeof value[key] === 'string' && (value[key] as string).length > 0);
  return (
    typeof value.key === 'string' &&
    value.key.length > 0 &&
    isSupportedLoginChannel(value.channel) &&
    QR_STATES.includes(value.state as QrState) &&
    Number.isFinite(value.createdAt) &&
    Number.isFinite(value.expiresAt) &&
    ['identifier', 'qrcodeId', 'imageUrl', 'authToken'].every(optionalText)
  );
};

const cloneQrSessionRecord = (session: QrSessionRecord): QrSessionRecord => ({ ...session });

/** Backwards-compatible default: the process-local map the service has always used. */
export const createMemoryQrSessionRepository = (
  seed: readonly QrSessionRecord[] = [],
): QrSessionRepository => {
  let stored = seed.filter(isQrSessionRecord).map(cloneQrSessionRecord);
  return {
    kind: 'memory',
    load: () => stored.map(cloneQrSessionRecord),
    save: (sessions) => {
      stored = sessions.map(cloneQrSessionRecord);
    },
  };
};

interface QrSessionStore {
  get(key: string): QrSessionRecord | null;
  set(session: QrSessionRecord): void;
  /** The service mutates records in place; this mirrors the current map into the repository. */
  persist(): void;
  delete(key: string): boolean;
  keys(): string[];
  values(): QrSessionRecord[];
}

/**
 * Mirrors `AuthSessionStore`: the map stays authoritative in-process and every mutation is
 * mirrored into the repository, whose failures never reach the login protocol.
 */
const createQrSessionStore = (repository: QrSessionRepository): QrSessionStore => {
  const sessions = new Map<string, QrSessionRecord>();

  const persist = (): void => {
    try {
      repository.save(Array.from(sessions.values(), cloneQrSessionRecord));
    } catch (error) {
      logger.warn('qq-auth.qr-session.save-failed', {
        kind: repository.kind,
        name: error instanceof Error ? error.name : 'Error',
      });
    }
  };

  let loaded: unknown;
  try {
    loaded = repository.load();
  } catch (error) {
    logger.warn('qq-auth.qr-session.load-failed', {
      kind: repository.kind,
      name: error instanceof Error ? error.name : 'Error',
    });
  }
  for (const value of Array.isArray(loaded) ? loaded : []) {
    if (isQrSessionRecord(value)) sessions.set(value.key, cloneQrSessionRecord(value));
  }

  return {
    get: (key) => sessions.get(key) ?? null,
    set: (session) => {
      // Stored by reference on purpose: the service mutates the live record through the same
      // object it has always used, and only the repository ever receives a copy.
      sessions.set(session.key, session);
      persist();
    },
    persist,
    delete: (key) => {
      const removed = sessions.delete(key);
      if (removed) persist();
      return removed;
    },
    keys: () => Array.from(sessions.keys()),
    values: () => Array.from(sessions.values()),
  };
};

interface WebSocketLike {
  readyState: number;
  on(event: string, listener: (...args: unknown[]) => void): WebSocketLike;
  once(event: string, listener: (...args: unknown[]) => void): WebSocketLike;
  removeListener(event: string, listener: (...args: unknown[]) => void): WebSocketLike;
  send(data: Buffer): void;
  close(): void;
}

interface WebSocketConstructor {
  new (url: string, protocol: string): WebSocketLike;
}

interface PacketQueue {
  next(timeoutMs: number): Promise<Buffer>;
}

export class QrLoginServiceError extends Error {
  public constructor(
    message: string,
    public readonly httpStatus: number,
    public readonly retryAfterMs?: number,
    public readonly upstreamCode?: number,
  ) {
    super(message);
    this.name = 'QrLoginServiceError';
  }
}

/**
 * QIMEI bootstrap rejection. Only the upstream numeric codes are carried; they are opaque
 * security codes and must never be renamed into an official error meaning.
 */
export class QqDeviceBootstrapError extends Error {
  public constructor(
    public readonly httpStatus: number,
    public readonly outerCode: number | undefined,
    public readonly innerCode: number | undefined,
  ) {
    super(
      `QIMEI bootstrap failed (HTTP ${httpStatus}, outer=${outerCode ?? 'unknown'}, inner=${innerCode ?? 'unknown'})`,
    );
    this.name = 'QqDeviceBootstrapError';
  }
}

export class QqProtocolError extends Error {
  public constructor(
    public readonly phase: string,
    public readonly upstreamCode: number | undefined,
    public readonly globalCode: number,
    public readonly httpStatus: number,
  ) {
    super(
      `${phase} failed (HTTP ${httpStatus}, global=${globalCode}, code=${upstreamCode ?? 'unknown'})`,
    );
    this.name = 'QqProtocolError';
  }
}

/**
 * `music.vkey.GetVkey/UrlGetVkey` answers with `midurlinfo` but an empty `sip`, unlike the legacy
 * web `CgiGetVkey`. Without a fallback the play URL degrades into a bare filename, which the
 * browser then resolves against its own origin. Measured 2026-08-06 against a real vkey: only
 * `dl.stream` serves it (HTTP 206 `audio/mpeg`); `isure.stream` and `ws.stream` answer 403.
 */
const DEFAULT_STREAM_DOMAIN = 'http://dl.stream.qqmusic.qq.com/';

const MUSIC_FILE_TYPES = {
  m4a: { prefix: 'C400', extension: '.m4a' },
  128: { prefix: 'M500', extension: '.mp3' },
  320: { prefix: 'M800', extension: '.mp3' },
  ape: { prefix: 'A000', extension: '.ape' },
  flac: { prefix: 'F000', extension: '.flac' },
} as const;

const getAuthenticatedPlayUrls = async (
  http: AuthHttpClient,
  auth: AuthSession,
  songmid: string,
  quality: string | number = 128,
  mediaId?: string,
): Promise<Dictionary> => {
  const songmidList = songmid
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const qualityKey = String(quality) as keyof typeof MUSIC_FILE_TYPES;
  const fileType = MUSIC_FILE_TYPES[qualityKey] ?? MUSIC_FILE_TYPES[128];
  const guid = crypto.randomUUID().replaceAll('-', '');
  const normalizedMediaId = stringOf(mediaId).trim();
  const data = await callMusicu(
    http,
    auth.device,
    'get-music-play',
    'music.vkey.GetVkey',
    'UrlGetVkey',
    {
      // filename 一律是两段识别值：`prefix + songmid + media_mid + extension`。media_mid 缺席时
      // 用 songmid 补上第二段；只送一段的文件名在 vkey server 仍会拿到 purl，但 CDN 端会 403。
      filename: songmidList.map(
        (mid) => `${fileType.prefix}${mid}${normalizedMediaId || mid}${fileType.extension}`,
      ),
      guid,
      songmid: songmidList,
      songtype: songmidList.map(() => 0),
      uin: stringOf(auth.credential.str_musicid) || String(auth.credential.musicid),
      ctx: 0,
    },
    auth.credential,
  );
  const sip = Array.isArray(data.sip) ? data.sip.map(stringOf).filter(Boolean) : [];
  const domain =
    sip.find((value) => !value.startsWith('http://ws')) ?? sip[0] ?? DEFAULT_STREAM_DOMAIN;
  const playUrl: Dictionary = {};
  const entries = Array.isArray(data.midurlinfo) ? data.midurlinfo : [];
  for (const entry of entries) {
    const item = dictionaryOf(entry);
    const mid = identifierOf(item.songmid);
    if (!mid) continue;
    const purl = stringOf(item.purl);
    playUrl[mid] = {
      url: purl ? `${domain}${purl}` : '',
      error: purl ? false : '暂无播放链接',
    };
  }
  return playUrl;
};

const encodeVariableInteger = (input: number): Buffer => {
  let value = input;
  const bytes: number[] = [];
  do {
    let digit = value % 128;
    value = Math.floor(value / 128);
    if (value > 0) digit |= 0x80;
    bytes.push(digit);
  } while (value > 0);
  return Buffer.from(bytes);
};

const decodeVariableInteger = (
  buffer: Buffer,
  offset = 0,
): { value: number; bytes: number } | null => {
  let multiplier = 1;
  let value = 0;
  for (let bytes = 0; bytes < 4; bytes += 1) {
    if (offset + bytes >= buffer.length) return null;
    const digit = buffer[offset + bytes];
    value += (digit & 0x7f) * multiplier;
    if ((digit & 0x80) === 0) return { value, bytes: bytes + 1 };
    multiplier *= 128;
  }
  throw new Error('Malformed MQTT variable integer');
};

const encodeUtf8 = (value: string): Buffer => {
  const data = Buffer.from(value, 'utf8');
  const size = Buffer.allocUnsafe(2);
  size.writeUInt16BE(data.length);
  return Buffer.concat([size, data]);
};

const encodeProperties = (
  authMethod: string | null,
  properties: Array<[string, string]>,
): Buffer => {
  const chunks: Buffer[] = [];
  if (authMethod) chunks.push(Buffer.from([0x15]), encodeUtf8(authMethod));
  for (const [key, value] of properties)
    chunks.push(Buffer.from([0x26]), encodeUtf8(key), encodeUtf8(value));
  const data = Buffer.concat(chunks);
  return Buffer.concat([encodeVariableInteger(data.length), data]);
};

const wrapPacket = (header: number, body: Buffer): Buffer =>
  Buffer.concat([Buffer.from([header]), encodeVariableInteger(body.length), body]);

const buildConnectPacket = (clientId: string, qrcodeId: string): Buffer => {
  const keepAlive = Buffer.allocUnsafe(2);
  keepAlive.writeUInt16BE(45);
  const properties = encodeProperties('pass', [
    ['tmeAppID', 'qqmusic'],
    ['business', 'management'],
    ['hashTag', qrcodeId],
    ['clientTag', 'management.user'],
    ['userID', qrcodeId],
  ]);
  return wrapPacket(
    0x10,
    Buffer.concat([
      encodeUtf8('MQTT'),
      Buffer.from([0x05, 0x02]),
      keepAlive,
      properties,
      encodeUtf8(clientId),
    ]),
  );
};

const buildSubscribePacket = (qrcodeId: string): Buffer => {
  const packetId = Buffer.from([0x00, 0x01]);
  const properties = encodeProperties(null, [
    ['authorization', 'tmelogin'],
    ['pubsub', 'unicast'],
  ]);
  return wrapPacket(
    0x82,
    Buffer.concat([
      packetId,
      properties,
      encodeUtf8(`management.qrcode_login/${qrcodeId}`),
      Buffer.from([0x00]),
    ]),
  );
};

const readUtf8 = (buffer: Buffer, offset: number): { value: string; next: number } => {
  const length = buffer.readUInt16BE(offset);
  const start = offset + 2;
  return { value: buffer.subarray(start, start + length).toString('utf8'), next: start + length };
};

const skipProperty = (buffer: Buffer, offset: number, id: number): number => {
  if ([0x03, 0x08, 0x12, 0x15, 0x1a, 0x1c, 0x1f].includes(id)) return readUtf8(buffer, offset).next;
  if ([0x13, 0x21, 0x22, 0x23].includes(id)) return offset + 2;
  if ([0x02, 0x11, 0x18, 0x27].includes(id)) return offset + 4;
  if ([0x01, 0x17, 0x19, 0x24, 0x25, 0x28, 0x29, 0x2a].includes(id)) return offset + 1;
  if ([0x09, 0x16].includes(id)) return offset + 2 + buffer.readUInt16BE(offset);
  if (id === 0x0b) {
    const value = decodeVariableInteger(buffer, offset);
    if (!value) throw new Error('Truncated MQTT subscription identifier');
    return offset + value.bytes;
  }
  throw new Error(`Unsupported MQTT property 0x${id.toString(16)}`);
};

const parseProperties = (buffer: Buffer, offset: number): { values: Dictionary; next: number } => {
  const length = decodeVariableInteger(buffer, offset);
  if (!length) throw new Error('Truncated MQTT properties');
  let cursor = offset + length.bytes;
  const end = cursor + length.value;
  const userProperties: Dictionary = {};
  const values: Dictionary = { userProperties };
  while (cursor < end) {
    const id = buffer[cursor];
    cursor += 1;
    if (id === 0x26) {
      const key = readUtf8(buffer, cursor);
      const value = readUtf8(buffer, key.next);
      userProperties[key.value] = value.value;
      cursor = value.next;
    } else if (id === 0x1c || id === 0x1f) {
      const value = readUtf8(buffer, cursor);
      values[id === 0x1c ? 'serverReference' : 'reasonString'] = value.value;
      cursor = value.next;
    } else cursor = skipProperty(buffer, cursor, id);
  }
  return { values, next: end };
};

const splitPackets = (buffer: Buffer): { packets: Buffer[]; rest: Buffer } => {
  const packets: Buffer[] = [];
  let cursor = 0;
  while (cursor < buffer.length) {
    const remaining = decodeVariableInteger(buffer, cursor + 1);
    if (!remaining) break;
    const end = cursor + 1 + remaining.bytes + remaining.value;
    if (end > buffer.length) break;
    packets.push(buffer.subarray(cursor, end));
    cursor = end;
  }
  return { packets, rest: buffer.subarray(cursor) };
};

const parseConnack = (packet: Buffer): Dictionary => {
  const remaining = decodeVariableInteger(packet, 1);
  if (!remaining) throw new Error('Truncated MQTT CONNACK');
  const offset = 1 + remaining.bytes;
  return { reasonCode: packet[offset + 1], ...parseProperties(packet, offset + 2).values };
};

const parsePublish = (packet: Buffer): QrEvent => {
  const remaining = decodeVariableInteger(packet, 1);
  if (!remaining) throw new Error('Truncated MQTT PUBLISH');
  let cursor = 1 + remaining.bytes;
  cursor = readUtf8(packet, cursor).next;
  if (((packet[0] >> 1) & 0x03) > 0) cursor += 2;
  const properties = parseProperties(packet, cursor);
  const users = dictionaryOf(properties.values.userProperties);
  const raw = packet.subarray(properties.next).toString('utf8');
  return { type: stringOf(users.type) || null, payload: raw ? parseDictionary(raw) : null };
};

const toBuffer = (value: unknown): Buffer => {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value))
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (Array.isArray(value) && value.every(Buffer.isBuffer)) return Buffer.concat(value);
  throw new Error('Unsupported MQTT WebSocket payload');
};

const createPacketQueue = (socket: WebSocketLike): PacketQueue => {
  let buffered: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  const packets: Buffer[] = [];
  const waiters: Array<{ resolve: (packet: Buffer) => void; reject: (error: Error) => void }> = [];
  let terminalError: Error | null = null;
  const settle = (): void => {
    while (waiters.length && packets.length) waiters.shift()?.resolve(packets.shift() as Buffer);
    while (terminalError && waiters.length) waiters.shift()?.reject(terminalError);
  };
  socket.on('message', (value) => {
    const split = splitPackets(Buffer.concat([buffered, toBuffer(value)]));
    buffered = split.rest;
    packets.push(...split.packets);
    settle();
  });
  socket.on('error', () => {
    terminalError = new Error('MQTT WebSocket error');
    settle();
  });
  socket.on('close', () => {
    terminalError = new Error('MQTT WebSocket closed');
    settle();
  });
  return {
    next(timeoutMs: number): Promise<Buffer> {
      if (packets.length) return Promise.resolve(packets.shift() as Buffer);
      if (terminalError) return Promise.reject(terminalError);
      return new Promise((resolve, reject) => {
        const waiter = { resolve, reject };
        waiters.push(waiter);
        const timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error('MQTT packet timeout'));
        }, timeoutMs);
        waiter.resolve = (packet) => {
          clearTimeout(timer);
          resolve(packet);
        };
        waiter.reject = (error) => {
          clearTimeout(timer);
          reject(error);
        };
      });
    },
  };
};

const openWebSocket = (path: string): Promise<WebSocketLike> =>
  new Promise((resolve, reject) => {
    const socket = new WebSocketRuntime(`wss://${MQTT_HOST}${path}`, 'mqtt');
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error('MQTT handshake timeout'));
    }, 20000);
    const onOpen = (): void => {
      clearTimeout(timer);
      socket.removeListener('error', onError);
      resolve(socket);
    };
    const onError = (): void => {
      clearTimeout(timer);
      socket.removeListener('open', onOpen);
      reject(new Error('MQTT handshake failed'));
    };
    socket.once('open', onOpen);
    socket.once('error', onError);
  });

const redirectPath = (path: string, reference: string): string => {
  const parts = path.replace(/\/$/, '').split('/');
  if (parts.at(-1)?.includes(':')) parts[parts.length - 1] = reference;
  else parts.push(reference);
  return parts.join('/');
};

const connectMqtt = async (qrcodeId: string) => {
  let path = MQTT_INITIAL_PATH;
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    const socket = await openWebSocket(path);
    const queue = createPacketQueue(socket);
    socket.send(buildConnectPacket(`${Date.now()}${randomDigits(4)}`, qrcodeId));
    const connack = parseConnack(await queue.next(20000));
    const reasonCode = numberOf(connack.reasonCode) ?? -1;
    if (reasonCode === 0) return { socket, queue };
    socket.close();
    const reference = stringOf(connack.serverReference);
    if (![0x9c, 0x9d].includes(reasonCode) || !reference || redirects === 3) {
      throw new Error(`MQTT CONNACK rejected: 0x${reasonCode.toString(16)}`);
    }
    path = redirectPath(path, reference);
  }
  throw new Error('MQTT redirect limit exceeded');
};

const subscribeToQrEvents = async (
  socket: WebSocketLike,
  queue: PacketQueue,
  qrcodeId: string,
  onEvent: (event: QrEvent) => void,
): Promise<void> => {
  socket.send(buildSubscribePacket(qrcodeId));
  while (true) {
    const packet = await queue.next(20000);
    if (packet[0] >> 4 === 9) {
      const reasonCode = packet.at(-1) ?? 0x80;
      if (reasonCode >= 0x80) throw new Error(`MQTT SUBACK rejected: 0x${reasonCode.toString(16)}`);
      return;
    }
    if (packet[0] >> 4 === 3) onEvent(parsePublish(packet));
  }
};

const consumeQrEvents = async (
  queue: PacketQueue,
  onEvent: (event: QrEvent) => void,
  timeoutMs: number,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const packet = await queue.next(Math.max(1, deadline - Date.now()));
    if (packet[0] >> 4 !== 3) continue;
    const event = parsePublish(packet);
    onEvent(event);
    if (['cookies', 'canceled', 'timeout', 'loginFailed'].includes(event.type ?? '')) return;
  }
  onEvent({ type: 'timeout', payload: null });
};

const defaultListen = (
  qrcodeId: string,
  onEvent: (event: QrEvent) => void,
  timeoutMs: number,
): QrEventListener => {
  let activeSocket: WebSocketLike | null = null;
  let readySettled = false;
  let resolveReady: () => void = () => undefined;
  let rejectReady: (error: Error) => void = () => undefined;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const done = (async (): Promise<void> => {
    const { socket, queue } = await connectMqtt(qrcodeId);
    activeSocket = socket;
    const ping = setInterval(() => {
      if (socket.readyState === 1) socket.send(Buffer.from([0xc0, 0x00]));
    }, 30000);
    try {
      await subscribeToQrEvents(socket, queue, qrcodeId, onEvent);
      onEvent({ type: 'waiting', payload: null });
      readySettled = true;
      resolveReady();
      await consumeQrEvents(queue, onEvent, timeoutMs);
    } catch (error) {
      if (!readySettled) rejectReady(error instanceof Error ? error : new Error(String(error)));
      throw error;
    } finally {
      clearInterval(ping);
      socket.close();
    }
  })();
  void done.catch(() => undefined);
  return { ready, done, close: () => activeSocket?.close() };
};

const buildQimeiHeadersAndBody = (
  device: AndroidDevice,
): { headers: Record<string, string>; body: Dictionary } => {
  const request = buildQimeiRequest(device);
  const rawHeaders = dictionaryOf(request.headers);
  const headers = Object.fromEntries(
    Object.entries(rawHeaders).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
  return { headers, body: dictionaryOf(request.body) };
};

/**
 * Reuses the stored QIMEI while it is fresh and returns whether the device context changed.
 * Diagnostics stay at code/type/length granularity: raw bodies and identifiers never leave
 * this function.
 */
const ensureQimei = async (
  http: AuthHttpClient,
  device: AndroidDevice,
  now: number,
): Promise<boolean> => {
  const fresh =
    device.qimei &&
    device.qimei36 &&
    device.qimeiSavedAt &&
    now - device.qimeiSavedAt < QIMEI_TTL_MS;
  if (fresh) {
    logger.info('qq-auth.qimei-result', { source: 'cache' });
    return false;
  }
  const request = buildQimeiHeadersAndBody(device);
  const response = await http.post<unknown>(QIMEI_URL, request.body, { headers: request.headers });
  const outer = parseDictionary(response.data);
  const inner = parseDictionary(outer.data);
  const data = dictionaryOf(inner.data);
  const qimei = stringOf(data.q16);
  const qimei36 = stringOf(data.q36);
  const outerCode = numberOf(outer.code);
  const innerCode = numberOf(inner.code);
  logger.info('qq-auth.qimei-result', {
    source: 'upstream',
    httpStatus: response.status,
    outerCode,
    outerDataType: typeof outer.data,
    innerCode,
    q16Length: qimei.length,
    q36Length: qimei36.length,
  });
  if (!qimei || !qimei36) throw new QqDeviceBootstrapError(response.status, outerCode, innerCode);
  device.qimei = qimei;
  device.qimei36 = qimei36;
  device.qimeiSavedAt = now;
  return true;
};

/** The cookie form of a credential, accepted by both the musicu RPC face and the legacy CGIs. */
const credentialCookieHeader = (credential: QqCredential): string => {
  const musicid = identifierOf(credential.str_musicid) || String(credential.musicid);
  return [
    `uin=${musicid}`,
    `qqmusic_uin=${musicid}`,
    `qm_keyst=${credential.musickey}`,
    `qqmusic_key=${credential.musickey}`,
  ].join('; ');
};

const callMusicu = async (
  http: AuthHttpClient,
  device: AndroidDevice,
  phase: string,
  module: string,
  method: string,
  param: Dictionary,
  credential?: QqCredential,
  overrides: Dictionary = {},
): Promise<Dictionary> => {
  const credentialCookies = credential ? credentialCookieHeader(credential) : '';
  const response = await http.post<unknown>(
    MUSICU_URL,
    {
      comm: buildAndroidComm(device, credential, overrides),
      req_0: { module, method, param },
    },
    {
      headers: {
        'User-Agent': `QQMusic 14090008(android ${device.osRelease})`,
        ...(credentialCookies ? { Cookie: credentialCookies } : {}),
      },
    },
  );
  const body = dictionaryOf(response.data);
  const item = dictionaryOf(body.req_0);
  const globalCode = numberOf(body.code) ?? 0;
  const upstreamCode = numberOf(item.code);
  logger.info('qq-auth.upstream-result', {
    phase,
    httpStatus: response.status,
    globalCode,
    upstreamCode,
  });
  if (!Object.keys(item).length || globalCode !== 0 || (upstreamCode ?? 0) !== 0) {
    throw new QqProtocolError(phase, upstreamCode, globalCode, response.status);
  }
  return dictionaryOf(item.data);
};

const refreshAndroidSession = async (
  http: AuthHttpClient,
  device: AndroidDevice,
): Promise<void> => {
  const data = await callMusicu(
    http,
    device,
    'get-session',
    'music.getSession.session',
    'GetSession',
    {
      uid: device.sessionUid ?? '',
      vkey: 0,
      caller: 0,
    },
  );
  const session = dictionaryOf(data.session);
  const uid = identifierOf(session.uid);
  const sid = identifierOf(session.sid);
  if (!uid || !sid) throw new Error('GetSession response missing uid/sid');
  device.sessionUid = uid;
  device.sessionSid = sid;
  device.sessionVkey = session.vkey;
};

const createNativeQr = async (http: AuthHttpClient, device: AndroidDevice) => {
  const data = await callMusicu(
    http,
    device,
    'create-qr',
    'music.login.LoginServer',
    'CreateQRCode',
    {
      tmeAppID: 'qqmusic',
      ct: 11,
      cv: 14090008,
    },
    undefined,
    { ct: 23, cv: 0 },
  );
  const qrcodeId = stringOf(data.qrcodeID);
  const encoded = stringOf(data.qrcode).split(',').at(-1) ?? '';
  const image = Buffer.from(encoded, 'base64');
  if (!qrcodeId || image.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
    throw new Error('CreateQRCode response missing a valid PNG/qrcodeID');
  }
  return {
    qrcodeId,
    imageUrl: `data:image/png;base64,${image.toString('base64')}`,
    expiresIn: numberOf(data.expiresIn),
  };
};

/**
 * `qq` is a push channel: the MQTT listener started here delivers events the instant they
 * arrive, which is what keeps this channel's timing identical to the pre-driver implementation.
 * `advance()` therefore has nothing left to observe.
 */
const createQqQrDriver = (options: {
  http: AuthHttpClient;
  device: () => AndroidDevice;
  listen: QrListenerFactory;
}): QrChannelDriver => {
  const listeners = new Map<string, QrEventListener>();
  return {
    mode: 'push',
    createQr: async () => {
      const qr = await createNativeQr(options.http, options.device());
      return { identifier: qr.qrcodeId, imageUrl: qr.imageUrl, expiresIn: qr.expiresIn };
    },
    start: (session, context) => {
      const listener = options.listen(session.identifier ?? '', context.onEvent, context.timeoutMs);
      listeners.set(session.key, listener);
      return listener;
    },
    advance: async () => [],
    close: (session) => {
      listeners.get(session.key)?.close();
      listeners.delete(session.key);
    },
  };
};

/**
 * `wechat` is a pull channel: every `advance()` is one time-boxed long poll and nothing runs
 * between calls. A closed dialog therefore stops polling immediately instead of holding a loop
 * open for the rest of the QR's life, and a serverless invocation can serve the channel at all.
 */
const createWechatQrDriver = (options: {
  http: (session: QrSessionRecord) => AuthHttpClient;
}): QrChannelDriver => ({
  mode: 'pull',
  createQr: async (session, signal) => {
    const qr = await createWechatQr(options.http(session), { signal });
    return { identifier: qr.identifier, imageUrl: qr.imageUrl };
  },
  advance: async (session, budgetMs, signal) => {
    if (!session.identifier) return [];
    try {
      const status = await pollWechatQr(options.http(session), session.identifier, {
        budgetMs,
        signal,
      });
      return [eventForWechatStatus(status)];
    } catch (error) {
      // The budget elapsing is the normal outcome of a long poll that saw no state change, so it
      // reports "nothing happened" rather than an upstream failure. A caller-driven abort is a
      // real cancellation and stays an error.
      if (isAbortError(error) && signal?.aborted !== true) return [];
      throw error;
    }
  },
  close: () => undefined,
});

const MOBILE_LOGIN_TYPE = 6;

const credentialFrom = (value: Dictionary, defaultLoginType: number): QqCredential => {
  const musicid = value.musicid ?? value.str_musicid;
  const musickey = stringOf(value.musickey);
  if ((!stringOf(musicid) && typeof musicid !== 'number') || !musickey)
    throw new Error('Login response missing credential');
  return {
    ...value,
    musicid: musicid as string | number,
    musickey,
    // The channel that produced the credential is the fallback, never a fixed 6: a WeChat
    // credential sent back with `tmeLoginType: 6` would be rejected on every later request.
    loginType: numberOf(value.loginType) ?? defaultLoginType,
  };
};

const PRIVATE_RESPONSE_KEYS = new Set([
  'musickey',
  'authst',
  'qqmusic_key',
  'token',
  'qimei',
  'qimei36',
  'sid',
  'vkey',
]);

const sanitizePublicValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sanitizePublicValue);
  if (!isDictionary(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !PRIVATE_RESPONSE_KEYS.has(key.toLowerCase()))
      .map(([key, item]) => [key, sanitizePublicValue(item)]),
  );
};

const exchangeCredential = async (
  http: AuthHttpClient,
  device: AndroidDevice,
  qrcodeId: string,
  musicid: string,
  token: string,
): Promise<QqCredential> =>
  credentialFrom(
    await callMusicu(
      http,
      device,
      'credential-exchange',
      'music.login.LoginServer',
      'Login',
      { musicid: Number(musicid), qrCodeID: qrcodeId, token },
      undefined,
      { tmeLoginType: MOBILE_LOGIN_TYPE },
    ),
    MOBILE_LOGIN_TYPE,
  );

/**
 * WeChat channel exchange: the OAuth `code` from the web flow, not an MQTT token. It runs on
 * the shared device-bound client because it is a musicu call and needs the Android comm; the
 * WeChat endpoints themselves never see that device context.
 */
const exchangeWechatCredential = async (
  http: AuthHttpClient,
  device: AndroidDevice,
  code: string,
): Promise<QqCredential> =>
  credentialFrom(
    await callMusicu(
      http,
      device,
      'credential-exchange',
      'music.login.LoginServer',
      'Login',
      { code, strAppid: WECHAT_APP_ID },
      undefined,
      { tmeLoginType: WECHAT_LOGIN_TYPE },
    ),
    WECHAT_LOGIN_TYPE,
  );

// QQMusicApi v0.6.6 treats these upstream numeric results as a signal to try the
// channel-specific credential refresh. They remain opaque safety codes here.
const CREDENTIAL_REFRESH_SAFETY_CODES = new Set([1000, 104401, 104400]);

/** 上游用这几个安全码明确表示「这份凭证我不认」，与超时、限流、协议变动等失败区分开。 */
const isCredentialRejection = (error: unknown): error is QqProtocolError =>
  error instanceof QqProtocolError &&
  error.upstreamCode !== undefined &&
  CREDENTIAL_REFRESH_SAFETY_CODES.has(error.upstreamCode);

/**
 * 在服务边界把「上游拒绝凭证」翻译成控制器层会回 401 的那一个错误。
 *
 * 只映射这三个已知安全码；其余上游失败保持原样，因此一次上游抖动不会把用户登出。上游的码是不透明
 * 数字，将来发现漏掉的码时在 `CREDENTIAL_REFRESH_SAFETY_CODES` 里补，映射逻辑不必改。
 */
const withCredentialRejectionMapped = async <T>(operation: () => Promise<T>): Promise<T> => {
  try {
    return await operation();
  } catch (error) {
    if (isCredentialRejection(error)) throw new AuthCredentialRejectedError(error.upstreamCode);
    throw error;
  }
};

const getLoginUserWithCredential = async (
  http: AuthHttpClient,
  device: AndroidDevice,
  credential: QqCredential,
): Promise<Dictionary> =>
  dictionaryOf(
    sanitizePublicValue(
      await callMusicu(
        http,
        device,
        'get-login-user',
        'music.UserInfo.userInfoServer',
        'GetLoginUserInfo',
        {},
        credential,
      ),
    ),
  );

const getLoginUser = async (http: AuthHttpClient, auth: AuthSession): Promise<Dictionary> =>
  getLoginUserWithCredential(http, auth.device, auth.credential);

/**
 * Builds the same public profile shape from the non-secret identity fields in a credential.
 *
 * The account id is the one `credentialMusicId` resolves, never the raw `musicid`: a WeChat
 * credential carries a placeholder there and keeps the real id in `str_musicid`, which is why
 * every upstream call this service makes already goes through that helper. Handing out the raw
 * field would publish an id the service itself refuses to key its own requests on.
 */
const publicProfileFromCredential = (credential: QqCredential): Dictionary => {
  const musicId = credentialMusicId(credential);
  const nickname = stringOf(credential.nick) || stringOf(credential.nickname);
  const avatarUrl = stringOf(credential.logo) || stringOf(credential.avatarUrl);
  return {
    ...(musicId ? { musicid: musicId, str_musicid: musicId } : {}),
    ...(nickname ? { nickname, nick: nickname } : {}),
    ...(avatarUrl ? { avatarUrl } : {}),
  };
};

/**
 * `GetLoginUserInfo` never carries an account id. Measured against a real session, its top-level
 * keys are `errMsg` / `identify` / `info` / `celebrityInfo` plus operational slots, and every
 * account field lives under the nested `info` — there is no `musicid` or `uin` anywhere in it.
 * The credential-derived profile is therefore layered underneath as a default instead of only
 * standing in when the call fails. The two key sets are disjoint, so a successful reply still
 * wins on every field it does answer with.
 *
 * 这里曾经还有一条 WeChat 专用的兜底：上游用安全码拒绝凭证时改回传凭证里的字段。那让 `/login/status`
 * 报告「已登录」，而同一份凭证在其余 `/user/*` 上全部失败，用户卡在一个自己清不掉的状态里。拒绝现在
 * 直接往外抛，由服务边界映射成 401。
 */
const getLoginProfile = async (http: AuthHttpClient, auth: AuthSession): Promise<Dictionary> => ({
  ...publicProfileFromCredential(auth.credential),
  ...(await getLoginUser(http, auth)),
});

/** Refreshes a WeChat credential with the complete field set returned by its QR exchange. */
const refreshWechatCredential = async (
  http: AuthHttpClient,
  device: AndroidDevice,
  credential: QqCredential,
): Promise<QqCredential> =>
  credentialFrom(
    await callMusicu(
      http,
      device,
      'credential-refresh',
      'music.login.LoginServer',
      'Login',
      {
        openid: stringOf(credential.openid),
        refresh_token: stringOf(credential.refresh_token),
        str_musicid: stringOf(credential.str_musicid) || String(credential.musicid),
        musickey: credential.musickey,
        unionid: stringOf(credential.unionid),
        refresh_key: stringOf(credential.refresh_key),
        loginMode: 2,
      },
      credential,
      { tmeLoginType: WECHAT_LOGIN_TYPE },
    ),
    WECHAT_LOGIN_TYPE,
  );

/** Refreshes the exchanged WeChat key once when the reference credential check requests it. */
const validateWechatCredential = async (
  http: AuthHttpClient,
  device: AndroidDevice,
  credential: QqCredential,
): Promise<QqCredential> => {
  try {
    await getLoginUserWithCredential(http, device, credential);
    return credential;
  } catch (error) {
    if (
      !(error instanceof QqProtocolError) ||
      error.upstreamCode === undefined ||
      !CREDENTIAL_REFRESH_SAFETY_CODES.has(error.upstreamCode)
    )
      throw error;
  }

  const refreshed = await refreshWechatCredential(http, device, credential);
  logger.info('qq-auth.credential-refreshed', {
    loginChannel: 'wechat',
    credentialLoginType: refreshed.loginType,
    credentialKeys: Object.keys(refreshed).sort(),
    credentialKeyLength: refreshed.musickey.length,
  });
  return refreshed;
};

/**
 * 会话到期时间跟着 musickey 自己的寿命走。
 *
 * 上游的凭证带着 `musickeyCreateTime`（epoch 秒）与 `keyExpiresIn`（秒，实测 259200 = 整三天）。
 * 之前这里硬编 24 小时，比上游短，于是用户每天都得重新扫码——而那并不是 QQ 要求的。缺字段或者值不
 * 合理时退回原来的 24 小时，结果再夹进 `[1 小时, 7 天]`，因此一份畸形的上游回应既不会立刻作废会话，
 * 也不会签发一个远超凭证寿命的会话。
 *
 * 凭证已经过期时算出来的时长是负的，会被夹到 1 小时；那一小时里任何一次上游调用都会被拒绝并映射成
 * 401，客户端照样能干净地登出。
 */
const authSessionExpiryAt = (credential: QqCredential, now: number): number => {
  const createdAtSeconds = numberOf(credential.musickeyCreateTime);
  const lifetimeSeconds = numberOf(credential.keyExpiresIn);
  if (!createdAtSeconds || !lifetimeSeconds || createdAtSeconds <= 0 || lifetimeSeconds <= 0)
    return now + AUTH_TTL_MS;
  const ttl = (createdAtSeconds + lifetimeSeconds) * 1000 - now;
  if (ttl < AUTH_TTL_MIN_MS) return now + AUTH_TTL_MIN_MS;
  if (ttl > AUTH_TTL_MAX_MS) return now + AUTH_TTL_MAX_MS;
  return now + ttl;
};

const getPlaylists = async (
  http: AuthHttpClient,
  auth: AuthSession,
  uin?: string,
): Promise<Dictionary> => {
  const created = await callMusicu(
    http,
    auth.device,
    'get-user-playlists',
    'music.musicasset.PlaylistBaseRead',
    'GetPlaylistByUin',
    { uin: uin || credentialMusicId(auth.credential) },
    auth.credential,
  );
  const createdPlaylists = Array.isArray(created.v_playlist) ? created.v_playlist : [];
  const favoritePlaylists: unknown[] = [];
  const encryptedUin = stringOf(auth.credential.encryptUin);

  if (encryptedUin) {
    const pageSize = 100;
    let offset = 0;
    while (offset < 1000) {
      const favoritePage = await callMusicu(
        http,
        auth.device,
        'get-user-favorite-playlists',
        'music.musicasset.PlaylistFavRead',
        'CgiGetPlaylistFavInfo',
        { uin: encryptedUin, offset, size: pageSize },
        auth.credential,
      );
      const pageItems = Array.isArray(favoritePage.v_list) ? favoritePage.v_list : [];
      favoritePlaylists.push(...pageItems);
      offset += pageItems.length;
      if (
        pageItems.length === 0 ||
        (favoritePage.hasmore !== true && numberOf(favoritePage.hasmore) !== 1)
      )
        break;
    }
  }

  const seen = new Set<string>();
  const playlists = [...createdPlaylists, ...favoritePlaylists].filter((value) => {
    const item = dictionaryOf(value);
    const id = identifierOf(item.tid ?? item.dissid ?? item.id ?? item.dirId ?? item.dirid);
    if (!id) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  return dictionaryOf(
    sanitizePublicValue({
      ...created,
      v_playlist: playlists,
      total: playlists.length,
      bFinish: true,
    }),
  );
};

const FAVORITE_ASSET_URL = 'https://c.y.qq.com/fav/fcgi-bin/fcg_get_profile_order_asset.fcg';
/** `2` selects favourite albums on this CGI; `3` selects favourite playlists. */
const FAVORITE_ALBUM_REQUEST_TYPE = 2;

/**
 * Favourite albums are the one user collection the musicu RPC face does not answer with.
 * Measured 2026-08-08 against a live session that had two favourited albums:
 * `music.musicasset.AlbumFavRead/CgiGetAlbumFavInfo` does exist, but always replies `80000`
 * with a zero-filled struct — under 13 param shapes (`{}` included) and 4 client identities.
 * The code therefore never meant "no rows", and no sibling method answers either
 * (`CgiGetAlbumFavList` is `40000`, `music.musicasset.SingerFavRead` is `500003`).
 *
 * This legacy profile-asset CGI does answer, and it takes the native QR credential as-is: the
 * same call with `reqtype=3` returns exactly the favourite playlists musicu reports, and falls
 * to `4000` when the cookie is withheld — so it is reading the login state, not public data.
 *
 * `sin`/`ein` bound an inclusive range, not an offset and a count.
 */
const getFavoriteAlbums = async (
  http: AuthHttpClient,
  auth: AuthSession,
  offset = 0,
  limit = 20,
): Promise<Dictionary> => {
  const safeOffset = Math.max(0, Math.floor(offset));
  const safeLimit = Math.min(100, Math.max(1, Math.floor(limit)));
  const response = await http.request<unknown>({
    url: FAVORITE_ASSET_URL,
    method: 'GET',
    params: {
      ct: 20,
      cid: 205360956,
      userid: credentialMusicId(auth.credential),
      reqtype: FAVORITE_ALBUM_REQUEST_TYPE,
      sin: safeOffset,
      ein: safeOffset + safeLimit - 1,
      format: 'json',
    },
    headers: {
      Referer: 'https://y.qq.com/',
      Cookie: credentialCookieHeader(auth.credential),
    },
  });
  const body = dictionaryOf(response.data);
  const code = numberOf(body.code) ?? 0;
  logger.info('qq-auth.upstream-result', {
    phase: 'get-user-favorite-albums',
    httpStatus: response.status,
    globalCode: code,
    upstreamCode: numberOf(body.subcode),
  });
  if (code !== 0)
    throw new QqProtocolError('get-user-favorite-albums', code, code, response.status);
  return dictionaryOf(sanitizePublicValue(dictionaryOf(body.data)));
};

const getLikedSongs = async (
  http: AuthHttpClient,
  auth: AuthSession,
  offset = 0,
  limit = 100,
): Promise<Dictionary> => {
  const encryptedUin = stringOf(auth.credential.encryptUin);
  if (!encryptedUin) throw new Error('Login credential is missing encryptUin');
  const safeOffset = Math.max(0, Math.floor(offset));
  const safeLimit = Math.min(100, Math.max(1, Math.floor(limit)));
  return dictionaryOf(
    sanitizePublicValue(
      await callMusicu(
        http,
        auth.device,
        'get-user-liked-songs',
        'music.srfDissInfo.DissInfo',
        'CgiGetDiss',
        {
          disstid: 0,
          dirid: 201,
          tag: true,
          song_begin: safeOffset,
          song_num: safeLimit,
          userinfo: true,
          orderlist: true,
          enc_host_uin: encryptedUin,
        },
        auth.credential,
      ),
    ),
  );
};

const terminalState = (state: QrState): boolean =>
  ['confirmed', 'expired', 'failed'].includes(state);

/**
 * States where the user is already acting on this QR from their phone. A second login attempt must
 * not pull the rug out from under that, so these keep the 409; every other non-terminal state is an
 * abandoned code and is preemptible. `confirmed` is deliberately absent: it is terminal, it never
 * blocked a new session, and blocking it would 409 anyone who signs out and back in inside the TTL.
 */
const confirmingState = (state: QrState): boolean => ['scanned', 'exchanging'].includes(state);

/** Keeps whatever opaque number the upstream gave us, whichever channel produced the failure. */
const upstreamCodeOf = (error: unknown): number | undefined => {
  if (error instanceof QqProtocolError) return error.upstreamCode;
  if (error instanceof WechatQrError) return error.upstreamCode;
  return undefined;
};

type QrListenerFactory = (
  qrcodeId: string,
  onEvent: (event: QrEvent) => void,
  timeoutMs: number,
) => QrEventListener;

class QrLoginServiceImpl implements QrLoginService {
  private readonly http: AuthHttpClient;
  private readonly createSessionHttp: () => AuthHttpClient;
  private readonly now: () => number;
  private readonly random: (size: number) => Buffer;
  private readonly capabilities: RuntimeCapabilities;
  private readonly checkBudgetMs: number;
  private readonly drivers: Partial<Record<QrLoginChannel, QrChannelDriver>>;
  private readonly qrSessionStore: QrSessionStore;
  private readonly qrRuntimes = new Map<string, QrSessionRuntime>();
  private readonly sessionResolver: SessionResolver;
  private readonly deviceStore: DeviceContextStore;
  private creatingSession = false;
  private failureCount = 0;
  private nextQrAllowedAt = 0;

  public constructor(dependencies: QrLoginDependencies) {
    this.http = dependencies.http ?? createAuthHttpClient();
    this.createSessionHttp = dependencies.createSessionHttp ?? createAuthHttpClient;
    this.now = dependencies.now ?? Date.now;
    this.random = dependencies.randomBytes ?? crypto.randomBytes;
    this.capabilities = dependencies.capabilities ?? NODE_RUNTIME_CAPABILITIES;
    this.checkBudgetMs = dependencies.checkBudgetMs ?? WECHAT_DEFAULT_POLL_BUDGET_MS;
    this.deviceStore = createDeviceContextStore(
      dependencies.deviceRepository ?? createDefaultDeviceContextRepository(),
    );
    this.sessionResolver =
      dependencies.sessionResolver ??
      createStoredSessionResolver({
        repository: dependencies.authSessionRepository ?? createMemoryAuthSessionRepository(),
        now: this.now,
        randomBytes: this.random,
      });
    this.qrSessionStore = createQrSessionStore(
      dependencies.qrSessionRepository ?? createMemoryQrSessionRepository(),
    );
    this.drivers = {
      qq: createQqQrDriver({
        http: this.http,
        device: () => this.deviceStore.get(),
        listen: dependencies.listen ?? defaultListen,
      }),
      wechat: createWechatQrDriver({ http: (session) => this.sessionHttp(session) }),
      ...dependencies.drivers,
    };
  }

  public getCapabilities(): RuntimeCapabilities {
    return this.capabilities;
  }

  private runtimeFor(session: QrSessionRecord): QrSessionRuntime {
    const existing = this.qrRuntimes.get(session.key);
    if (existing) return existing;
    const driver = this.drivers[session.channel];
    if (!driver)
      throw new QrLoginServiceError(`Unsupported QR login channel: ${session.channel}`, 400);
    const runtime: QrSessionRuntime = { driver, pollErrors: 0 };
    this.qrRuntimes.set(session.key, runtime);
    return runtime;
  }

  private dropSession(session: QrSessionRecord): void {
    const runtime = this.qrRuntimes.get(session.key);
    runtime?.listener?.close();
    runtime?.driver.close(session);
    this.qrRuntimes.delete(session.key);
    this.qrSessionStore.delete(session.key);
  }

  private cleanup(): void {
    const current = this.now();
    for (const session of this.qrSessionStore.values()) {
      if (session.expiresAt > current) continue;
      // A pull channel has no background timer to raise `timeout` at expiry, so the expiry itself
      // has to keep counting as a failure. Both guards mirror when a push listener would have
      // raised it: only after a code exists to scan, and only if nothing terminal happened first.
      // A key that was issued and abandoned before `createQr` never backed anything off.
      if (!terminalState(session.state) && session.imageUrl !== undefined) this.backoff();
      this.dropSession(session);
    }
    this.sessionResolver.cleanup?.();
  }

  private backoff(): number {
    this.failureCount += 1;
    const delay = Math.min(BACKOFF_BASE_MS * 2 ** (this.failureCount - 1), BACKOFF_MAX_MS);
    this.nextQrAllowedAt = this.now() + delay;
    return delay;
  }

  private confirmingQrExists(): boolean {
    return this.qrSessionStore.values().some((session) => confirmingState(session.state));
  }

  /**
   * Closes and drops the codes nobody is scanning. Without this a dialog that was opened and shut
   * without a scan would hold the slot for the whole QR TTL, so the next login attempt — including
   * the one after a hard app restart, where no cancel could ever be sent — got a 409 it could not
   * clear by retrying.
   */
  private discardPreemptibleSessions(): void {
    for (const session of this.qrSessionStore.values()) {
      if (terminalState(session.state) || confirmingState(session.state)) continue;
      this.dropSession(session);
      logger.info('qq-auth.qr-session-preempted', { loginChannel: session.channel });
    }
  }

  private sessionFor(key: string): QrSessionRecord {
    this.cleanup();
    const session = this.qrSessionStore.get(key);
    if (!session) throw new QrLoginServiceError('QR session not found or expired', 404);
    return session;
  }

  private async authFor(token?: string): Promise<AuthSession | null> {
    this.cleanup();
    return this.sessionResolver.resolve(token);
  }

  /**
   * Turns a pre-session bootstrap failure into a backed-off client error, so repeated clicks
   * get one 502 with Retry-After and then 429s instead of a stream of upstream calls.
   */
  private failBootstrap(error: unknown): QrLoginServiceError {
    if (error instanceof QrLoginServiceError) return error;
    const bootstrap = error instanceof QqDeviceBootstrapError ? error : null;
    const protocol = error instanceof QqProtocolError ? error : null;
    const retryAfterMs = this.backoff();
    const upstreamCode = bootstrap?.outerCode ?? protocol?.upstreamCode;
    logger.warn('qq-auth.bootstrap-failed', {
      phase: bootstrap ? 'qimei' : (protocol?.phase ?? 'unknown'),
      outerCode: bootstrap?.outerCode,
      innerCode: bootstrap?.innerCode,
      upstreamCode: protocol?.upstreamCode,
      retryAfterMs,
      name: error instanceof Error ? error.name : 'Error',
    });
    return new QrLoginServiceError('Unable to start QR login', 502, retryAfterMs, upstreamCode);
  }

  private failSession(session: QrSessionRecord, error: unknown): void {
    if (terminalState(session.state)) return;
    session.state = 'failed';
    session.upstreamCode = upstreamCodeOf(error);
    session.retryAfterMs = this.backoff();
    this.qrSessionStore.persist();
    logger.warn('qq-auth.session-failed', {
      loginChannel: session.channel,
      upstreamCode: session.upstreamCode,
      retryAfterMs: session.retryAfterMs,
      name: error instanceof Error ? error.name : 'Error',
    });
  }

  /** QQ App channel: the MQTT payload carries an exchange token, never the final credential. */
  private async exchangeQqLogin(session: QrSessionRecord, payload: unknown): Promise<QqCredential> {
    const cookies = dictionaryOf(dictionaryOf(payload).cookies);
    const musicid = stringOf(dictionaryOf(cookies.qqmusic_uin).value);
    const mqttToken = stringOf(dictionaryOf(cookies.qqmusic_key).value);
    if (!musicid || !mqttToken || !session.qrcodeId)
      throw new Error('MQTT cookies missing login credential');
    session.state = 'exchanging';
    const device = this.deviceStore.get();
    try {
      return await exchangeCredential(this.http, device, session.qrcodeId, musicid, mqttToken);
    } catch (error) {
      const direct = {
        musicid,
        str_musicid: musicid,
        musickey: mqttToken,
        loginType: MOBILE_LOGIN_TYPE,
      };
      await getLoginUser(this.http, {
        token: '',
        credential: direct,
        device,
        expiresAt: 0,
      });
      logger.warn('qq-auth.exchange-fallback', {
        upstreamCode: error instanceof QqProtocolError ? error.upstreamCode : undefined,
      });
      return direct;
    }
  }

  /** WeChat channel: the web flow yields an OAuth code, and there is no MQTT fallback. */
  private async exchangeWechatLogin(
    session: QrSessionRecord,
    payload: unknown,
  ): Promise<QqCredential> {
    const code = stringOf(dictionaryOf(payload).code);
    if (!code) throw new WechatQrError('WeChat authorization missing code');
    session.state = 'exchanging';
    return exchangeWechatCredential(this.http, this.deviceStore.get(), code);
  }

  private async finalizeLogin(session: QrSessionRecord, payload: unknown): Promise<void> {
    let credential =
      session.channel === 'wechat'
        ? await this.exchangeWechatLogin(session, payload)
        : await this.exchangeQqLogin(session, payload);
    if (session.channel === 'wechat')
      credential = await validateWechatCredential(this.http, this.deviceStore.get(), credential);
    const token = await this.sessionResolver.issue({
      credential,
      device: this.deviceStore.get(),
      expiresAt: authSessionExpiryAt(credential, this.now()),
    });
    session.authToken = token;
    session.state = 'confirmed';
    this.qrSessionStore.persist();
    this.failureCount = 0;
    this.nextQrAllowedAt = 0;
    logger.info('qq-auth.login-confirmed', {
      loginChannel: session.channel,
      hasCredential: true,
      credentialLoginType: credential.loginType,
      credentialKeys: Object.keys(credential).sort(),
      credentialKeyLength: credential.musickey.length,
    });
  }

  private onQrEvent(session: QrSessionRecord, event: QrEvent): void {
    if (terminalState(session.state)) return;
    if (event.type === 'waiting') session.state = 'waiting';
    else if (event.type === 'scanned') session.state = 'scanned';
    else if (event.type === 'cookies' || event.type === 'authorized') {
      const runtime = this.runtimeFor(session);
      // Started the same way for both driver modes. A push channel leaves it running in the
      // background exactly as before; a pull channel awaits it inside the same `advance()` so an
      // invocation never ends with the credential exchange still in flight.
      runtime.finalizing = this.finalizeLogin(session, event.payload).catch((error) =>
        this.failSession(session, error),
      );
      void runtime.finalizing;
    } else if (['canceled', 'timeout', 'loginFailed'].includes(event.type ?? '')) {
      session.state = 'expired';
      session.retryAfterMs = this.backoff();
    }
    this.qrSessionStore.persist();
  }

  /**
   * Gives a pull channel its one time-boxed look at the upstream. Push channels have already
   * delivered whatever arrived, so this is a no-op for them.
   */
  private async advanceSession(session: QrSessionRecord, budgetMs: number): Promise<void> {
    const runtime = this.runtimeFor(session);
    if (runtime.driver.mode !== 'pull' || terminalState(session.state)) return;
    let events: QrEvent[];
    try {
      events = await runtime.driver.advance(session, budgetMs);
      runtime.pollErrors = 0;
    } catch (error) {
      // A dropped long poll is normal; only a run of them fails the session. This is the same
      // tolerance the self-driving WeChat loop applied before it became a pull driver.
      runtime.pollErrors += 1;
      if (runtime.pollErrors > MAX_CONSECUTIVE_POLL_ERRORS) this.failSession(session, error);
      return;
    }
    for (const event of events) this.onQrEvent(session, event);
    await runtime.finalizing;
  }

  public async createSession(
    channel: QrLoginChannel | LegacyQrLoginChannel = DEFAULT_LOGIN_CHANNEL,
  ): Promise<string> {
    // Normalizing here rather than deeper in is what keeps the legacy alias a boundary concern:
    // every field, log and comparison below this line only ever sees a canonical channel.
    const loginChannel = normalizeLoginChannel(channel);
    // Validated against this runtime's declared capabilities, not a module-level constant, so a
    // runtime that cannot serve a channel rejects it instead of failing further in.
    if (!loginChannel || !this.capabilities.channels.includes(loginChannel))
      throw new QrLoginServiceError(`Unsupported QR login channel: ${channel}`, 400);
    this.cleanup();
    const retryAfterMs = Math.max(0, this.nextQrAllowedAt - this.now());
    if (retryAfterMs > 0)
      throw new QrLoginServiceError('QR login is temporarily backed off', 429, retryAfterMs);
    // The concurrency lock and a QR that is mid-confirmation are the only real 409s left.
    if (this.creatingSession || this.confirmingQrExists())
      throw new QrLoginServiceError('Another QR login is already active', 409);
    this.discardPreemptibleSessions();
    this.creatingSession = true;
    try {
      const device = this.deviceStore.get();
      if (await ensureQimei(this.http, device, this.now())) this.deviceStore.persist();
      await refreshAndroidSession(this.http, device);
      this.deviceStore.persist();
      const key = this.random(24).toString('hex');
      this.qrSessionStore.set({
        key,
        channel: loginChannel,
        state: 'created',
        createdAt: this.now(),
        expiresAt: this.now() + QR_TTL_MS,
      });
      logger.info('qq-auth.qr-session-created', { loginChannel });
      return key;
    } catch (error) {
      throw this.failBootstrap(error);
    } finally {
      this.creatingSession = false;
    }
  }

  /**
   * Releases one QR session by key. Keyed on purpose: clearing every session would let one client
   * closing its dialog kill a QR another client is confirming on their phone.
   */
  public cancelSession(key: string): void {
    const session = this.qrSessionStore.get(key);
    // Idempotent by contract. The client cancels on dialog close as fire-and-forget, so an unknown
    // or already expired key is a success, never a 404.
    if (!session) return;
    // A confirmed session is left to expire on its own: the credential already reached authSessions
    // and a poll still in flight has to keep reading 803 rather than flip a login into "expired".
    if (session.state === 'confirmed') return;
    this.dropSession(session);
    logger.info('qq-auth.qr-session-canceled', { loginChannel: session.channel });
  }

  private sessionHttp(session: QrSessionRecord): AuthHttpClient {
    const runtime = this.runtimeFor(session);
    if (!runtime.http) runtime.http = this.createSessionHttp();
    return runtime.http;
  }

  public async createQr(key: string): Promise<string> {
    const session = this.sessionFor(key);
    if (session.imageUrl) return session.imageUrl;
    if (session.state !== 'created')
      throw new QrLoginServiceError('QR session cannot create another code', 409);
    const runtime = this.runtimeFor(session);
    session.state = 'creating';
    try {
      const qr = await runtime.driver.createQr(session);
      session.identifier = qr.identifier;
      if (session.channel === 'qq') session.qrcodeId = qr.identifier;
      session.imageUrl = qr.imageUrl;
      if (qr.expiresIn && qr.expiresIn > 0) {
        session.expiresAt = Math.min(session.expiresAt, this.now() + qr.expiresIn * 1000);
      }
      logger.info('qq-auth.qr-created', {
        loginChannel: session.channel,
        qrIdentifierLength: qr.identifier.length,
      });
      if (runtime.driver.start) {
        // The listener deadline is still computed after `expiresIn` narrowed the record, which is
        // exactly the order the pre-driver implementation used.
        const listener = runtime.driver.start(session, {
          onEvent: (event) => this.onQrEvent(session, event),
          timeoutMs: session.expiresAt - this.now(),
        });
        runtime.listener = listener;
        void listener.done.catch((error) => this.failSession(session, error));
        await listener.ready;
      } else {
        // A pull channel is scannable the moment the code exists. The self-driving loop it
        // replaces emitted this same event before its first poll.
        this.onQrEvent(session, { type: 'waiting', payload: null });
      }
      this.qrSessionStore.persist();
      return qr.imageUrl;
    } catch (error) {
      this.failSession(session, error);
      throw new QrLoginServiceError('Unable to create QR login', 502, session.retryAfterMs);
    }
  }

  public async checkQr(key: string, budgetMs: number = this.checkBudgetMs): Promise<QrCheckResult> {
    try {
      const session = this.sessionFor(key);
      await this.advanceSession(session, budgetMs);
      if (session.state === 'confirmed' && session.authToken) {
        return {
          code: 803,
          message: 'Authorization login successful',
          cookie: `qqmusic_session=${session.authToken}`,
        };
      }
      if (session.state === 'scanned' || session.state === 'exchanging')
        return { code: 802, message: 'QR code scanned' };
      if (session.state === 'expired' || session.state === 'failed')
        return this.failedCheckResult(session);
      return { code: 801, message: 'Waiting for QR scan' };
    } catch {
      return { code: 800, message: 'QR code expired' };
    }
  }

  private failedCheckResult(session: QrSessionRecord): QrCheckResult {
    return {
      code: 800,
      message: session.state === 'expired' ? 'QR code expired' : 'QR login failed',
      ...(session.upstreamCode === undefined ? {} : { upstreamCode: session.upstreamCode }),
      ...(session.retryAfterMs === undefined ? {} : { retryAfterMs: session.retryAfterMs }),
    };
  }

  /**
   * `/login/status` 在没有可用会话时回 200 加一个空载荷，客户端靠 `data.profile` 在不在判断登录态。
   * 因此凭证被上游拒绝时这里回报「未登录」而不是抛错，让它和「根本没带 token」走同一条路；其余需要
   * 登录的路由仍然回 401。
   */
  public async getLoginStatus(token?: string): Promise<Dictionary | null> {
    const auth = await this.authFor(token);
    if (!auth) return null;
    try {
      return await withCredentialRejectionMapped(() => getLoginProfile(this.http, auth));
    } catch (error) {
      if (error instanceof AuthCredentialRejectedError) return null;
      throw error;
    }
  }

  public async getUserDetail(token?: string): Promise<Dictionary | null> {
    const auth = await this.authFor(token);
    return auth ? withCredentialRejectionMapped(() => getLoginProfile(this.http, auth)) : null;
  }

  public async getUserPlaylists(token?: string, uin?: string): Promise<Dictionary | null> {
    const auth = await this.authFor(token);
    return auth ? withCredentialRejectionMapped(() => getPlaylists(this.http, auth, uin)) : null;
  }

  public async getUserAlbums(
    token?: string,
    offset?: number,
    limit?: number,
  ): Promise<Dictionary | null> {
    const auth = await this.authFor(token);
    return auth
      ? withCredentialRejectionMapped(() => getFavoriteAlbums(this.http, auth, offset, limit))
      : null;
  }

  public async getUserLikedSongs(
    token?: string,
    offset?: number,
    limit?: number,
  ): Promise<Dictionary | null> {
    const auth = await this.authFor(token);
    return auth
      ? withCredentialRejectionMapped(() => getLikedSongs(this.http, auth, offset, limit))
      : null;
  }

  public async getMusicPlay(
    token: string | undefined,
    songmid: string,
    quality?: string | number,
    mediaId?: string,
  ): Promise<Dictionary | null> {
    const auth = await this.authFor(token);
    return auth
      ? withCredentialRejectionMapped(() =>
          getAuthenticatedPlayUrls(this.http, auth, songmid, quality, mediaId),
        )
      : null;
  }

  /**
   * Electron's lifeline, unchanged in shape. A sealed resolver has no repository to swap, so the
   * call is a no-op there rather than an error: the hook exists for hosts that keep credentials on
   * the server, and a runtime that does not is not misconfigured for ignoring it.
   */
  public configureAuthSessionRepository(repository: AuthSessionRepository): void {
    this.sessionResolver.useRepository?.(repository);
  }

  public async logout(token?: string): Promise<void> {
    if (token) await this.sessionResolver.revoke(token);
    for (const session of this.qrSessionStore.values()) this.dropSession(session);
  }
}

export const createQrLoginService = (dependencies: QrLoginDependencies = {}): QrLoginService =>
  new QrLoginServiceImpl(dependencies);

export const qrLoginService = createQrLoginService();

/**
 * Runtime hook for embedding hosts. Folia calls this immediately after loading the npm package,
 * before the event loop can accept a request, so the singleton used by every controller sees the
 * restored encrypted sessions without exposing credentials through the HTTP surface.
 */
export const configureAuthSessionRepository = (repository: AuthSessionRepository): void => {
  qrLoginService.configureAuthSessionRepository(repository);
};

export default qrLoginService;
