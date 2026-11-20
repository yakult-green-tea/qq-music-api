import { QqApiError } from '../../protocol/errors';
import type { PlaybackEntryCodes } from '../../protocol/playbackDiagnostics';
import { playbackFileTypeOf } from '../../protocol/playbackFiles';
import type { PlaybackProtocolId } from '../../protocol/playbackSource';
import type { AuthHttpClient } from '../../transport/httpClientTypes';
import { type PlaybackStrategy, webSessionVKeyStrategy } from './playbackStrategies';

// src/services/auth/playbackFallback.ts
//
// 主路径（含原因没确认时的再取一次）之后还没链接的歌，要不要换一种办法再试。由宿主决定开不开：Node 和
// serverless 默认开着，`QQ_PLAYBACK_FALLBACK_ENABLED` 设成 0 或 false 关掉；直接建服务、不传开关时关着。
// 登记的候选只有官方网页播放器身份：同一会员账号在 App 身份被挡的歌，官方网页播放器能放完整歌曲，
// 同账号、同歌、同出口实测换这一组拿到完整文件（四种音质，CDN 总长等于详情的文件大小）。
// 以后要加别的候选，也要先有这样的对照，再登记在这里。
//
// 规则：
//   - 开关关着：一个请求都不多，结果逐字不变（取链接那边连计数都不包）。
//   - 每个候选自己说认不认得这种失败（看音质、上游码、提示、账号类型）；同一次请求每个候选最多试一次，
//     几首歌合成一个请求。
//   - 整次取链接共用一个请求上限和时间上限；主路径打过的请求也算在里面。用完就不再试，记一笔。
//   - 候选回的是请求的那首、文件名认得出而且是要的那种音质、没加密，才采用；否则保留原来的结果。
//   - 每次尝试只记候选名、结果、首数、拿到几首和耗时，不记歌曲 id、网址或账号。

export interface PlaybackFallbackContext {
  /** 这次要的音质（m4a、128、320、flac、ape）。 */
  quality: string;
  /** 主路径这首歌的上游数字，原样。 */
  codes: PlaybackEntryCodes;
  /** 主路径给的提示 key（如果有）。 */
  hintKey?: string;
  /** 凭证的账号类型；有的做法对某种账号一律被拒，候选可以据此排除。 */
  loginType?: number;
}

export interface PlaybackFallbackCandidate {
  /** 记在 source.protocol 和日志里的名字。 */
  id: PlaybackProtocolId;
  appliesTo(context: PlaybackFallbackContext): boolean;
  /** 固定的做法，或按这次要的音质给做法（文件名前缀跟着音质变）。 */
  strategy: PlaybackStrategy | ((quality: string) => PlaybackStrategy);
}

/** 候选这次要用的做法。 */
export const candidateStrategyOf = (
  candidate: PlaybackFallbackCandidate,
  quality: string,
): PlaybackStrategy =>
  typeof candidate.strategy === 'function' ? candidate.strategy(quality) : candidate.strategy;

/** 官方网页播放器身份试这几种音质；ape 没文件时上游也会给假链接，试听另有路，都不试。 */
const WEB_SESSION_QUALITIES = new Set(['m4a', '128', '320', 'flac']);

/** 安卓身份明确回 104003（没给完整文件）时，换官方网页播放器身份再要一次。 */
export const WEB_SESSION_CANDIDATE: PlaybackFallbackCandidate = {
  id: 'web-session-vkey',
  appliesTo: ({ quality, codes }) => WEB_SESSION_QUALITIES.has(quality) && codes.result === 104003,
  strategy: (quality) => webSessionVKeyStrategy(playbackFileTypeOf(quality)),
};

export interface PlaybackFallbackLimits {
  /** 整次取链接（含主路径）最多打几次上游的 musicu 请求。 */
  maxRequests: number;
  /** 从这次取链接开始算，超过这么久就不再试候选；正在等的候选也不再等。 */
  timeoutMs: number;
}

export interface PlaybackFallbackOptions {
  enabled: boolean;
  /** 不给就用 PLAYBACK_FALLBACK_CANDIDATES。 */
  candidates?: readonly PlaybackFallbackCandidate[];
  limits?: PlaybackFallbackLimits;
  now?: () => number;
}

/** 登记的候选，按顺序试：见文件开头。 */
export const PLAYBACK_FALLBACK_CANDIDATES: readonly PlaybackFallbackCandidate[] = [
  WEB_SESSION_CANDIDATE,
];

/** 宿主读环境变量用的开关：没设或其他值都开着，只有 0 和 false 关掉。 */
export const playbackFallbackEnabledOf = (value: string | undefined): boolean =>
  !['0', 'false'].includes(value ?? '');

export const DEFAULT_PLAYBACK_FALLBACK_LIMITS: PlaybackFallbackLimits = {
  maxRequests: 16,
  timeoutMs: 10_000,
};

export const PLAYBACK_FALLBACK_DISABLED: PlaybackFallbackOptions = { enabled: false };

export type PlaybackFallbackOutcome =
  | 'granted'
  | 'refused'
  | 'invalid'
  | 'error'
  | 'timeout'
  | 'skipped-budget'
  | 'skipped-timeout';

/** 一次取链接（quality=best 的几级共用同一个）的请求和时间预算。 */
export class PlaybackRequestBudget {
  private requests = 0;
  private readonly startedAt: number;

  public constructor(
    private readonly limits: PlaybackFallbackLimits,
    private readonly now: () => number,
  ) {
    this.startedAt = now();
  }

  public count(): void {
    this.requests += 1;
  }

  public get used(): number {
    return this.requests;
  }

  public hasRequests(): boolean {
    return this.requests < this.limits.maxRequests;
  }

  public remainingMs(): number {
    return this.limits.timeoutMs - (this.now() - this.startedAt);
  }

  public elapsedSince(start: number): number {
    return Math.max(0, this.now() - start);
  }

  public clock(): number {
    return this.now();
  }
}

export const playbackBudgetOf = (options: PlaybackFallbackOptions): PlaybackRequestBudget =>
  new PlaybackRequestBudget(
    options.limits ?? DEFAULT_PLAYBACK_FALLBACK_LIMITS,
    options.now ?? Date.now,
  );

/** 主路径用的客户端：每打一次上游就记一笔，其余照旧。只在开关开着时包。 */
export const countingHttpOf = (
  http: AuthHttpClient,
  budget: PlaybackRequestBudget,
): AuthHttpClient => ({
  getCookieHeader: () => http.getCookieHeader(),
  request: (config) => {
    budget.count();
    return http.request(config);
  },
  post: (url, data, config) => {
    budget.count();
    return http.post(url, data, config);
  },
});

/** 显式加密取链接共用这些限额，超时会终止正在发送的请求。 */
export const withBoundedPlaybackHttp = async <T>(
  http: AuthHttpClient,
  operation: (boundedHttp: AuthHttpClient) => Promise<T>,
  limits = DEFAULT_PLAYBACK_FALLBACK_LIMITS,
  externalSignal?: AbortSignal,
): Promise<T> => {
  const budget = new PlaybackRequestBudget(limits, Date.now);
  const abort = new AbortController();
  const timeoutError = () => new QqApiError('network', { errorKey: 'network.timeout' });
  const reserve = () => {
    if (abort.signal.aborted || budget.remainingMs() <= 0) throw timeoutError();
    if (!budget.hasRequests()) throw new QqApiError('rate-limited');
    budget.count();
  };
  const beforeRequest = () => {
    reserve();
    return { signal: abort.signal, followRedirects: false as const };
  };
  const bounded: AuthHttpClient = {
    getCookieHeader: () => http.getCookieHeader(),
    request: (config) => http.request({ ...config, ...beforeRequest() }),
    post: (url, data, config) => http.post(url, data, { ...config, ...beforeRequest() }),
  };
  let timedOut = false;
  const cancel = () => abort.abort();
  const interrupted = new Promise<never>((_resolve, reject) => {
    abort.signal.addEventListener(
      'abort',
      () =>
        reject(
          timedOut ? timeoutError() : new QqApiError('network', { errorKey: 'network.aborted' }),
        ),
      { once: true },
    );
  });
  if (externalSignal?.aborted) cancel();
  else externalSignal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    abort.abort();
  }, limits.timeoutMs);
  try {
    const result = await Promise.race([
      interrupted,
      abort.signal.aborted ? interrupted : operation(bounded),
    ]);
    return result;
  } catch (error) {
    if (abort.signal.aborted)
      throw timedOut ? timeoutError() : new QqApiError('network', { errorKey: 'network.aborted' });
    throw error;
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', cancel);
  }
};

const TIMED_OUT = Symbol('timed-out');

/** 最多等 `ms` 毫秒；等不到回 TIMED_OUT。上游那边的请求没法取消，结果到了也不用。 */
export const withinPlaybackDeadline = async <T>(
  work: Promise<T>,
  ms: number,
): Promise<T | typeof TIMED_OUT> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), Math.max(0, ms));
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

export const isPlaybackDeadlineMiss = (value: unknown): value is typeof TIMED_OUT =>
  value === TIMED_OUT;
