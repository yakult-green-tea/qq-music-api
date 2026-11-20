import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getAuthenticatedPlaybackSources } from '../src/services/auth/playback';
import {
  PLAYBACK_FALLBACK_CANDIDATES,
  type PlaybackFallbackCandidate,
  type PlaybackFallbackOptions,
  playbackFallbackEnabledOf,
} from '../src/services/auth/playbackFallback';
import { StreamCdnSelector } from '../src/services/auth/streamCdnSelector';
import type { AuthHttpClient } from '../src/transport/httpClientTypes';
import { logger } from '../src/util/logger';
import deviceFixture from './fixtures/contracts/device-v1.json';
import { CONTRACT_CREDENTIAL, CONTRACT_NOW } from './helpers/contractUpstream';

// 备援框架：开关默认关；关着时取链接一个请求都不多、结果逐字不变。开着时，主路径（含再取一次）之后还没链接、
// 而且候选自己认得这种失败的歌，才交给候选试一次；整次取链接共用请求上限和时间上限。候选给的结果要是请求的那首、
// 文件种类对得上才算数，否则保留原来的结果。每次尝试只记候选名、结果、首数和耗时，不记歌曲 id。
// 登记的候选只有官方网页播放器身份（文件最后一节）；前面用测试自己的候选验框架。

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

  it('登记的候选只有官方网页播放器身份这一个', () => {
    expect(PLAYBACK_FALLBACK_CANDIDATES.map((candidate) => candidate.id)).toEqual([
      'web-session-vkey',
    ]);
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
    expect(await on.resolve(A, { enabled: true, candidates: [] })).toEqual(before);
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

// 官方网页播放器身份：同一个账号在 App（安卓）身份被挡的歌，官方网页播放器登录后能拿到完整文件
// （2026-11 会员账号实测）。备援只在主路径明确 104003 时，用同一个接口、同一个文件名，换成网页播放器的
// comm、标头和 Cookie 再要一次；comm 里不带安卓设备与 authst。
describe('官方网页播放器身份候选', () => {
  beforeEach(() => {
    jest.spyOn(logger, 'info').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  type Sent = {
    comm: Record<string, unknown>;
    param: Record<string, unknown>;
    method: string;
    headers: Record<string, string>;
  };
  /** 安卓身份的取链接都回 `android`，网页身份（ct 24）回 `web`；其他（查原因的详情）回空。 */
  const webHarness = (replies: { android: unknown; web?: unknown }) => {
    const sent: Sent[] = [];
    const http = {
      getCookieHeader: () => '',
      request: async () => {
        throw new Error('unexpected');
      },
      post: async (
        _url: string,
        body: {
          comm: Record<string, unknown>;
          req_0: { method: string; param: Record<string, unknown> };
        },
        config?: { headers?: Record<string, string> },
      ) => {
        sent.push({
          comm: body.comm,
          param: body.req_0.param,
          method: body.req_0.method,
          headers: config?.headers ?? {},
        });
        const data =
          body.req_0.method !== 'UrlGetVkey'
            ? {}
            : body.comm.ct === 24
              ? (replies.web ?? {})
              : replies.android;
        return { status: 200, data: { code: 0, req_0: { code: 0, data } } };
      },
    } as unknown as AuthHttpClient;
    const selector = new StreamCdnSelector(async () => ({ bytes: 1024, elapsedMs: 1 }));
    const vkey = (ct: number) =>
      sent.filter((call) => call.method === 'UrlGetVkey' && (call.comm.ct === 24) === (ct === 24));
    return {
      sent,
      web: () => vkey(24),
      android: () => vkey(11),
      resolve: (songmid: string, quality: string | number = 128, options = {}, enabled = true) =>
        getAuthenticatedPlaybackSources(
          http,
          auth,
          selector,
          songmid,
          quality,
          undefined,
          options,
          true,
          { enabled },
        ),
    };
  };
  const gtkOf = (key: string) => {
    let hash = 5381;
    for (const char of key) hash += (hash << 5) + char.charCodeAt(0);
    return hash & 0x7fffffff;
  };
  const refusedReply = (songmid: string) => ({ sip: [SIP], midurlinfo: [refused(songmid)] });
  const grantedReply = (songmid: string, purl = fullPurl(songmid)) => ({
    sip: [SIP],
    midurlinfo: [{ songmid, purl, result: 0 }],
  });

  it('主路径明确 104003：换网页播放器身份再要一次，拿到的完整文件换上，source 标成 web-session-vkey', async () => {
    const h = webHarness({ android: refusedReply(A), web: grantedReply(A) });
    const { playUrl } = await h.resolve(A);
    const [web] = h.web();
    expect(h.web()).toHaveLength(1);
    expect(web.param.filename).toEqual(h.android()[0].param.filename);
    expect(web.param).toMatchObject({
      songmid: [A],
      songtype: [0],
      uin: CONTRACT_CREDENTIAL.str_musicid,
      loginflag: 1,
      platform: '20',
    });
    const gtk = gtkOf(CONTRACT_CREDENTIAL.musickey);
    expect(web.comm).toEqual({
      ct: 24,
      cv: 4747474,
      platform: 'yqq.json',
      format: 'json',
      inCharset: 'utf-8',
      outCharset: 'utf-8',
      notice: 0,
      needNewCode: 1,
      uin: CONTRACT_CREDENTIAL.str_musicid,
      g_tk: gtk,
      g_tk_new_20200303: gtk,
    });
    expect(web.headers['User-Agent']).toMatch(/^Mozilla\/5\.0 /);
    expect(web.headers.Referer).toBe('https://y.qq.com/');
    expect(web.headers.Cookie).toBe(h.android()[0].headers.Cookie);
    expect(playUrl[A]).toMatchObject({
      url: `${SIP}${fullPurl(A)}`,
      error: false,
      source: { kind: 'full', protocol: 'web-session-vkey' },
    });
  });

  it.each([
    ['m4a', 'C400', '.m4a'],
    ['320', 'M800', '.mp3'],
    ['flac', 'F000', '.flac'],
  ])('%s 也会试，文件名照主路径', async (quality, prefix, ext) => {
    const purl = `${prefix}${A}${A}${ext}?vkey=fixture`;
    const h = webHarness({ android: refusedReply(A), web: grantedReply(A, purl) });
    const { playUrl } = await h.resolve(A, quality);
    expect(h.web()).toHaveLength(1);
    expect(h.web()[0].param.filename).toEqual(h.android()[0].param.filename);
    expect(playUrl[A]).toMatchObject({ url: `${SIP}${purl}` });
  });

  it('主路径拿到了：不多打请求', async () => {
    const h = webHarness({ android: grantedReply(A) });
    await h.resolve(A);
    expect(h.web()).toEqual([]);
  });

  it('ape 不试（没有文件时上游也会给假链接）', async () => {
    const h = webHarness({ android: refusedReply(A) });
    await h.resolve(A, 'ape');
    expect(h.web()).toEqual([]);
  });

  it('不是 104003 的拒绝：不试', async () => {
    const h = webHarness({
      android: { sip: [SIP], midurlinfo: [{ songmid: A, purl: '', result: 104009, subcode: 0 }] },
    });
    await h.resolve(A);
    expect(h.web()).toEqual([]);
  });

  it('试听请求不试', async () => {
    const h = webHarness({ android: refusedReply(A) });
    await h.resolve(A, 128, { preview: true });
    expect(h.web()).toEqual([]);
  });

  it('网页身份给的是别的音质或试听文件：不采用，保留原来的结果', async () => {
    const h = webHarness({
      android: refusedReply(A),
      web: grantedReply(A, `RS02${A}.mp3?vkey=x`),
    });
    const { playUrl } = await h.resolve(A);
    expect(playUrl[A]).toMatchObject({ url: '', error: '暂无播放链接' });
  });

  it('网页身份也被拒：保留原来的结果', async () => {
    const h = webHarness({ android: refusedReply(A), web: refusedReply(A) });
    const { playUrl } = await h.resolve(A);
    expect(h.web()).toHaveLength(1);
    expect(playUrl[A]).toMatchObject({ url: '', error: '暂无播放链接' });
  });

  it.each([
    128,
    'flac',
    'best',
  ])('网页身份也被拒（quality=%p）：整份结果和关掉备援时一模一样', async (quality) => {
    const off = await webHarness({ android: refusedReply(A) }).resolve(A, quality, {}, false);
    const h = webHarness({ android: refusedReply(A), web: refusedReply(A) });
    const on = await h.resolve(A, quality);
    expect(h.web().length).toBeGreaterThan(0);
    expect(on).toEqual(off);
  });
});

describe('备援开关', () => {
  it('没设或设成其他值时开着，只有 0 和 false 关掉', () => {
    expect(playbackFallbackEnabledOf(undefined)).toBe(true);
    expect(playbackFallbackEnabledOf('')).toBe(true);
    expect(playbackFallbackEnabledOf('1')).toBe(true);
    expect(playbackFallbackEnabledOf('0')).toBe(false);
    expect(playbackFallbackEnabledOf('false')).toBe(false);
  });

  it('Node 与 serverless 两个宿主都用同一个判断', () => {
    for (const file of ['../src/services/auth/qrLogin.node.ts', '../src/serverless/index.ts']) {
      const source = readFileSync(resolve(__dirname, file), 'utf8');
      expect(source).toContain('playbackFallbackEnabledOf(');
    }
  });
});
