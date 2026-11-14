import { getAuthenticatedPlaybackSources } from '../src/services/auth/playback';
import {
  PLAYBACK_FALLBACK_CANDIDATES,
  type PlaybackFallbackCandidate,
  type PlaybackFallbackOptions,
} from '../src/services/auth/playbackFallback';
import { StreamCdnSelector } from '../src/services/auth/streamCdnSelector';
import type { AuthHttpClient } from '../src/transport/httpClientTypes';
import { logger } from '../src/util/logger';
import deviceFixture from './fixtures/contracts/device-v1.json';
import { CONTRACT_CREDENTIAL, CONTRACT_NOW } from './helpers/contractUpstream';

// 备援框架：开关默认关；关着时取链接一个请求都不多、结果逐字不变。开着时，主路径（含再取一次）之后还没链接、
// 而且候选自己认得这种失败的歌，才交给候选试一次；整次取链接共用请求上限和时间上限。候选给的结果要是请求的那首、
// 文件种类对得上才算数，否则保留原来的结果。每次尝试只记候选名、结果、首数和耗时，不记歌曲 id。
// 目前没有登记任何候选（实测没有能多拿到歌的做法），这里用测试自己的候选验框架。

const A = 'fixtureSongMidA1';
const B = 'fixtureSongMidB2';
const SIP = 'https://stream.invalid/';
const auth = {
  token: 'fixture-token',
  credential: CONTRACT_CREDENTIAL,
  device: deviceFixture.device,
  expiresAt: CONTRACT_NOW + 1000,
};
const refused = (songmid: string) => ({ songmid, purl: '', result: 104003, subcode: 1 });

const harness = (upstream: Record<string, unknown>) => {
  const methods: string[] = [];
  const http = {
    getCookieHeader: () => '',
    request: async () => {
      throw new Error('unexpected');
    },
    post: async (_url: string, body: { req_0: { method: string } }) => {
      methods.push(body.req_0.method);
      return {
        status: 200,
        data: { code: 0, req_0: { code: 0, data: upstream[body.req_0.method] ?? {} } },
      };
    },
  } as unknown as AuthHttpClient;
  const selector = new StreamCdnSelector(async () => ({ bytes: 1024, elapsedMs: 1 }));
  return {
    methods,
    resolve: (
      songmid: string,
      fallback?: PlaybackFallbackOptions,
      quality: string | number = 128,
    ) =>
      getAuthenticatedPlaybackSources(
        http,
        auth,
        selector,
        songmid,
        quality,
        undefined,
        {},
        true,
        fallback,
      ),
  };
};

const candidateOf = (
  reply: unknown,
  overrides: Partial<PlaybackFallbackCandidate> = {},
): PlaybackFallbackCandidate & { calls: string[][] } => {
  const calls: string[][] = [];
  return {
    id: 'evkey-plain',
    appliesTo: (context) => context.quality === '128' && context.codes.result === 104003,
    strategy: {
      id: 'evkey-plain',
      filenameOf: (songmid) => `M500${songmid}${songmid}.mp3`,
      request: async (_context, items) => {
        calls.push(items.map((item) => item.songmid));
        if (reply instanceof Error) throw reply;
        return reply as Record<string, unknown>;
      },
    },
    calls,
    ...overrides,
  };
};

const fullPurl = (songmid: string) => `M500${songmid}${songmid}.mp3?vkey=fixture`;

describe('备援框架', () => {
  beforeEach(() => {
    jest.spyOn(logger, 'info').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('目前没有登记任何候选', () => {
    expect(PLAYBACK_FALLBACK_CANDIDATES).toEqual([]);
  });

  it('开关关着（默认）：候选不会被叫到，请求数和结果都和没有框架时一样', async () => {
    const upstream = { UrlGetVkey: { sip: [SIP], midurlinfo: [refused(A)] } };
    const plain = harness(upstream);
    const before = await plain.resolve(A);
    const candidate = candidateOf({ sip: [SIP], midurlinfo: [{ songmid: A, purl: fullPurl(A) }] });
    const off = harness(upstream);
    const after = await off.resolve(A, { enabled: false, candidates: [candidate] });
    expect(after).toEqual(before);
    expect(off.methods).toEqual(plain.methods);
    expect(candidate.calls).toEqual([]);
    expect(jest.mocked(logger.info).mock.calls.map(([event]) => event)).not.toContain(
      'playback.fallback-result',
    );
  });

  it('开关开着但没有候选：结果和请求数都不变', async () => {
    const upstream = { UrlGetVkey: { sip: [SIP], midurlinfo: [refused(A)] } };
    const plain = harness(upstream);
    const before = await plain.resolve(A);
    const on = harness(upstream);
    expect(await on.resolve(A, { enabled: true })).toEqual(before);
    expect(on.methods).toEqual(plain.methods);
  });

  it('开着、候选认得这种失败：只对还没链接的歌试一次，拿到的链接换上，source 标成候选的办法', async () => {
    const upstream = {
      UrlGetVkey: { sip: [SIP], midurlinfo: [refused(A), { songmid: B, purl: 'b.audio' }] },
    };
    const candidate = candidateOf({ sip: [SIP], midurlinfo: [{ songmid: A, purl: fullPurl(A) }] });
    const { resolve } = harness(upstream);
    const { playUrl, sources } = await resolve(`${A},${B}`, {
      enabled: true,
      candidates: [candidate],
    });
    expect(candidate.calls).toEqual([[A]]);
    expect(playUrl[A]).toEqual({
      url: `${SIP}${fullPurl(A)}`,
      error: false,
      source: {
        kind: 'full',
        protocol: 'evkey-plain',
        cdn: 'response-sip',
        quality: '128',
        codec: 'mp3',
      },
    });
    expect(playUrl[B]).toMatchObject({ url: `${SIP}b.audio`, error: false });
    expect(sources.find((source) => source.songmid === A)).toMatchObject({
      protocol: 'evkey-plain',
      access: 'full',
    });
    expect(logger.info).toHaveBeenCalledWith('playback.fallback-result', {
      candidate: 'evkey-plain',
      outcome: 'granted',
      songs: 1,
      granted: 1,
      elapsedMs: expect.any(Number),
    });
    expect(JSON.stringify(jest.mocked(logger.info).mock.calls)).not.toContain(A);
  });

  it.each([
    ['回的是别首歌', { sip: [SIP], midurlinfo: [{ songmid: B, purl: fullPurl(B) }] }, 'refused'],
    [
      '文件种类对不上（要 128 给了 m4a）',
      { sip: [SIP], midurlinfo: [{ songmid: A, purl: `C400${A}${A}.m4a` }] },
      'invalid',
    ],
    ['认不出的文件名', { sip: [SIP], midurlinfo: [{ songmid: A, purl: 'a.audio' }] }, 'invalid'],
    ['也没给链接', { sip: [SIP], midurlinfo: [refused(A)] }, 'refused'],
  ])('候选%s：不采用，保留原来的结果', async (_name, reply, outcome) => {
    const upstream = { UrlGetVkey: { sip: [SIP], midurlinfo: [refused(A)] } };
    const plain = await harness(upstream).resolve(A);
    const candidate = candidateOf(reply);
    const result = await harness(upstream).resolve(A, { enabled: true, candidates: [candidate] });
    expect(candidate.calls).toEqual([[A]]);
    expect(result.playUrl).toEqual(plain.playUrl);
    expect(logger.info).toHaveBeenCalledWith(
      'playback.fallback-result',
      expect.objectContaining({ candidate: 'evkey-plain', outcome, granted: 0 }),
    );
  });

  it('候选的请求本身出错：不让整个回应失败，保留原来的结果', async () => {
    const upstream = { UrlGetVkey: { sip: [SIP], midurlinfo: [refused(A)] } };
    const plain = await harness(upstream).resolve(A);
    const candidate = candidateOf(new Error('upstream down'));
    const result = await harness(upstream).resolve(A, { enabled: true, candidates: [candidate] });
    expect(result.playUrl).toEqual(plain.playUrl);
    expect(logger.info).toHaveBeenCalledWith(
      'playback.fallback-result',
      expect.objectContaining({ outcome: 'error', granted: 0 }),
    );
  });

  it('候选不认得这种失败：不叫它', async () => {
    const upstream = { UrlGetVkey: { sip: [SIP], midurlinfo: [refused(A)] } };
    const candidate = candidateOf({}, { appliesTo: () => false });
    await harness(upstream).resolve(A, { enabled: true, candidates: [candidate] });
    expect(candidate.calls).toEqual([]);
  });

  it('候选看得到账号类型，可以排除会被一律拒绝的账号', async () => {
    const upstream = { UrlGetVkey: { sip: [SIP], midurlinfo: [refused(A)] } };
    const seen: unknown[] = [];
    const candidate = candidateOf(
      {},
      {
        appliesTo: (context) => {
          seen.push(context.loginType);
          return false;
        },
      },
    );
    await harness(upstream).resolve(A, { enabled: true, candidates: [candidate] });
    expect(seen).toEqual([CONTRACT_CREDENTIAL.loginType]);
  });

  it('试听请求不走备援', async () => {
    const upstream = {
      get_song_detail_yqq: { track_info: { file: { size_try: 1, media_mid: 'FixtureMedia01' } } },
      UrlGetVkey: { sip: [SIP], midurlinfo: [{ songmid: A, purl: '', result: 104003 }] },
    };
    const candidate = candidateOf({}, { appliesTo: () => true });
    const { methods } = harness(upstream);
    await getAuthenticatedPlaybackSources(
      {
        getCookieHeader: () => '',
        request: async () => {
          throw new Error('unexpected');
        },
        post: async (_url: string, body: { req_0: { method: string } }) => {
          methods.push(body.req_0.method);
          return {
            status: 200,
            data: {
              code: 0,
              req_0: { code: 0, data: (upstream as Record<string, unknown>)[body.req_0.method] },
            },
          };
        },
      } as unknown as AuthHttpClient,
      auth,
      new StreamCdnSelector(async () => ({ bytes: 1024, elapsedMs: 1 })),
      A,
      128,
      undefined,
      { preview: true },
      true,
      { enabled: true, candidates: [candidate] },
    );
    expect(candidate.calls).toEqual([]);
  });

  it('整次取链接的请求已经用到上限：不再试候选，记一笔 skipped-budget', async () => {
    // 主路径：取链接 1 次、查原因详情 1 次、再取一次 1 次，共 3 次。
    const upstream = { UrlGetVkey: { sip: [SIP], midurlinfo: [refused(A)] } };
    const candidate = candidateOf({ sip: [SIP], midurlinfo: [{ songmid: A, purl: fullPurl(A) }] });
    const { resolve, methods } = harness(upstream);
    const result = await resolve(A, {
      enabled: true,
      candidates: [candidate],
      limits: { maxRequests: 3, timeoutMs: 10_000 },
    });
    expect(methods).toHaveLength(3);
    expect(candidate.calls).toEqual([]);
    expect(result.playUrl[A]).toMatchObject({ url: '' });
    expect(logger.info).toHaveBeenCalledWith(
      'playback.fallback-result',
      expect.objectContaining({ outcome: 'skipped-budget', songs: 1, granted: 0 }),
    );
  });

  it('上限还够：候选那一次也算进请求数', async () => {
    const upstream = { UrlGetVkey: { sip: [SIP], midurlinfo: [refused(A)] } };
    const first = candidateOf({ sip: [SIP], midurlinfo: [refused(A)] });
    const second = candidateOf({ sip: [SIP], midurlinfo: [{ songmid: A, purl: fullPurl(A) }] });
    const result = await harness(upstream).resolve(A, {
      enabled: true,
      candidates: [first, second],
      limits: { maxRequests: 4, timeoutMs: 10_000 },
    });
    expect(first.calls).toEqual([[A]]);
    expect(second.calls).toEqual([]);
    expect(result.playUrl[A]).toMatchObject({ url: '' });
  });

  it('时间用完：候选的请求等不到就放弃，保留原来的结果，记一笔 timeout', async () => {
    const upstream = { UrlGetVkey: { sip: [SIP], midurlinfo: [refused(A)] } };
    const candidate = candidateOf(
      {},
      {
        strategy: {
          id: 'evkey-plain',
          filenameOf: (songmid) => `M500${songmid}${songmid}.mp3`,
          request: () => new Promise(() => undefined),
        },
      },
    );
    let clock = 0;
    const result = await harness(upstream).resolve(A, {
      enabled: true,
      candidates: [candidate],
      limits: { maxRequests: 10, timeoutMs: 30 },
      now: () => clock,
    });
    clock += 0;
    expect(result.playUrl[A]).toMatchObject({ url: '' });
    expect(logger.info).toHaveBeenCalledWith(
      'playback.fallback-result',
      expect.objectContaining({ outcome: 'timeout', granted: 0 }),
    );
  });

  it('开始前时间就已经用完：不叫候选', async () => {
    const upstream = { UrlGetVkey: { sip: [SIP], midurlinfo: [refused(A)] } };
    const candidate = candidateOf({ sip: [SIP], midurlinfo: [{ songmid: A, purl: fullPurl(A) }] });
    let clock = 0;
    const now = () => {
      clock += 100;
      return clock;
    };
    await harness(upstream).resolve(A, {
      enabled: true,
      candidates: [candidate],
      limits: { maxRequests: 10, timeoutMs: 50 },
      now,
    });
    expect(candidate.calls).toEqual([]);
    expect(logger.info).toHaveBeenCalledWith(
      'playback.fallback-result',
      expect.objectContaining({ outcome: 'skipped-timeout' }),
    );
  });
});
