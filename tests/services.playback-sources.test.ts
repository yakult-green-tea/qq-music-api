import { PLAYBACK_FILE_TYPES } from '../src/protocol/playbackFiles';
import { PLAYBACK_PROTOCOLS } from '../src/protocol/playbackSource';
import { getAuthenticatedPlaybackSources } from '../src/services/auth/playback';
import { androidVKeyStrategy, previewRs02Strategy } from '../src/services/auth/playbackStrategies';
import { StreamCdnSelector } from '../src/services/auth/streamCdnSelector';
import type { AuthHttpClient } from '../src/transport/httpClientTypes';
import deviceFixture from './fixtures/contracts/device-v1.json';
import { CONTRACT_CREDENTIAL, CONTRACT_NOW } from './helpers/contractUpstream';

// 取播放链接时内部的音源描述：完整、试听、不确定分开记，取到链接、CDN 怎么定、音频有没有验过也分开记。
// 这些只在内部用，对外的 playUrl 不带它们；对外形状由 operations.music-play-baseline 守着。

const A = 'fixtureSongMidA1';
const B = 'fixtureSongMidB2';
const MEDIA = 'FixtureMedia01';
const SIP = 'https://stream.invalid/';
const auth = {
  token: 'fixture-token',
  credential: CONTRACT_CREDENTIAL,
  device: deviceFixture.device,
  expiresAt: CONTRACT_NOW + 1000,
};

type Reply = Record<string, unknown>;
/** 按上游方法名回 data；给数组时依次用，用完后一直用最后一个。 */
const harness = (replies: Record<string, Reply | Reply[]>, probeOk = true) => {
  const queues = new Map<string, Reply[]>();
  const methods: string[] = [];
  const http = {
    post: async (_url: string, body: { req_0: { method: string } }) => {
      const { method } = body.req_0;
      methods.push(method);
      const configured = replies[method] ?? {};
      const queue = queues.get(method) ?? (Array.isArray(configured) ? [...configured] : []);
      queues.set(method, queue);
      const data = Array.isArray(configured)
        ? queue.length > 1
          ? queue.shift()
          : queue[0]
        : configured;
      return { status: 200, data: { code: 0, req_0: { code: 0, data } } };
    },
  } as unknown as AuthHttpClient;
  const selector = new StreamCdnSelector(async () =>
    probeOk ? { bytes: 1024, elapsedMs: 1 } : null,
  );
  return {
    methods,
    resolve: (songmid: string, quality: string | number = 128, mediaId?: string, preview = false) =>
      getAuthenticatedPlaybackSources(http, auth, selector, songmid, quality, mediaId, { preview }),
  };
};
const granted = (songmid: string, extra: Reply = {}) => ({
  songmid,
  purl: `${songmid}.audio`,
  ...extra,
});
const refused = (songmid: string) => ({ songmid, purl: '', result: 104003, subcode: 1 });

describe('内部的音源描述', () => {
  it('完整链接：记下办法、身份、音质，CDN 来自回应，音频没验过', async () => {
    const { resolve } = harness({ UrlGetVkey: { sip: [SIP], midurlinfo: [granted(A)] } });
    const { playUrl, sources } = await resolve(A);
    expect(sources).toEqual([
      {
        songmid: A,
        kind: 'full',
        requestedQuality: '128',
        attemptedQuality: '128',
        protocol: 'android-vkey',
        profile: 'android',
        url: `${SIP}${A}.audio`,
        granted: true,
        cdn: 'response-sip',
        audioVerified: false,
        codes: {},
      },
    ]);
    expect(playUrl).toEqual({
      [A]: {
        url: `${SIP}${A}.audio`,
        error: false,
        source: { kind: 'full', protocol: 'android-vkey', cdn: 'response-sip' },
      },
    });
  });

  it('有链接却带着失败的结果码：内部和对外的 source 都记成不确定，链接照旧交出', async () => {
    const { resolve } = harness({
      UrlGetVkey: { sip: [SIP], midurlinfo: [granted(A, { result: 104003, subcode: 1 })] },
    });
    const { playUrl, sources } = await resolve(A);
    expect(sources[0]).toMatchObject({ kind: 'unknown', granted: true });
    expect(sources[0].codes).toEqual({ result: 104003, subcode: 1 });
    expect(playUrl[A]).toEqual({
      url: `${SIP}${A}.audio`,
      error: false,
      source: { kind: 'unknown', protocol: 'android-vkey', cdn: 'response-sip' },
    });
  });

  it('试听：记成试听并带 media id，片段起止不填，详情里的 try_begin／try_end 不拿来用', async () => {
    const { resolve } = harness({
      get_song_detail_yqq: {
        track_info: {
          file: { size_try: 1, media_mid: MEDIA, try_begin: 64000, try_end: 94000 },
        },
      },
      UrlGetVkey: { sip: [SIP], midurlinfo: [granted(A)] },
    });
    const { playUrl, sources } = await resolve(A, 128, undefined, true);
    expect(sources[0]).toMatchObject({
      kind: 'preview',
      protocol: 'preview-rs02',
      attemptedQuality: 'preview',
      mediaMid: MEDIA,
    });
    expect(sources[0]).not.toHaveProperty('previewStartMs');
    expect(sources[0]).not.toHaveProperty('previewEndMs');
    expect(sources[0]).not.toHaveProperty('playableDurationMs');
    expect(playUrl[A]).toEqual({
      url: `${SIP}${A}.audio`,
      error: false,
      preview: true,
      source: { kind: 'preview', protocol: 'preview-rs02', cdn: 'response-sip' },
    });
  });

  it('没给链接：granted 是 false，没有地址，谈不上 CDN', async () => {
    const { resolve } = harness({ UrlGetVkey: { sip: [SIP], midurlinfo: [refused(A)] } });
    const { sources } = await resolve(A, 320);
    expect(sources).toEqual([
      {
        songmid: A,
        kind: 'full',
        requestedQuality: '320',
        attemptedQuality: '320',
        protocol: 'android-vkey',
        profile: 'android',
        url: '',
        granted: false,
        cdn: 'none',
        audioVerified: false,
        codes: { result: 104003, subcode: 1 },
      },
    ]);
  });

  it.each([
    [true, 'probed'],
    [false, 'unverified-default'],
  ] as const)('回应没带地址、探测结果 %s：CDN 记成 %s', async (probeOk, cdn) => {
    const { resolve } = harness(
      { UrlGetVkey: { sip: [], midurlinfo: [granted(A)] }, GetCdnDispatch: { sip: [] } },
      probeOk,
    );
    const { sources } = await resolve(A);
    expect(sources[0]).toMatchObject({ granted: true, cdn });
  });

  it('上游给了有效秒数才记，没给不估', async () => {
    const withExpiration = harness({
      UrlGetVkey: { sip: [SIP], expiration: 80400, midurlinfo: [granted(A)] },
    });
    expect((await withExpiration.resolve(A)).sources[0].upstreamExpirationSeconds).toBe(80400);
    const without = harness({ UrlGetVkey: { sip: [SIP], midurlinfo: [granted(A)] } });
    expect((await without.resolve(A)).sources[0]).not.toHaveProperty('upstreamExpirationSeconds');
  });

  it('文件名用了可信的 media id 才记 mediaMid', async () => {
    const reply = { UrlGetVkey: { sip: [SIP], midurlinfo: [granted(A)] } };
    expect((await harness(reply).resolve(A, 128, MEDIA)).sources[0].mediaMid).toBe(MEDIA);
    expect((await harness(reply).resolve(A, 128, 'short')).sources[0]).not.toHaveProperty(
      'mediaMid',
    );
  });

  it('quality=best：记下调用方要的是 best，以及实际拿到的是哪一级', async () => {
    const { resolve } = harness({
      get_song_detail_yqq: { track_info: { file: { size_flac: 1, size_320mp3: 1 } } },
      UrlGetVkey: [
        { sip: [SIP], midurlinfo: [refused(A)] },
        { sip: [SIP], midurlinfo: [granted(A)] },
      ],
    });
    const { playUrl, sources } = await resolve(A, 'best');
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({
      requestedQuality: 'best',
      attemptedQuality: '320',
      kind: 'full',
      granted: true,
    });
    expect(playUrl[A]).toMatchObject({ quality: '320', error: false });
  });

  it('再取一次拿到链接：这首歌的描述换成拿到的那一次', async () => {
    const { resolve, methods } = harness({
      UrlGetVkey: [
        { sip: [SIP], midurlinfo: [refused(A)] },
        { sip: [SIP], midurlinfo: [granted(A)] },
      ],
    });
    const { sources } = await resolve(A);
    expect(methods.filter((method) => method === 'UrlGetVkey')).toHaveLength(2);
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({ granted: true, kind: 'full', codes: {} });
  });

  it('被文件守门挡下、没向上游要过的歌不在描述里', async () => {
    const { resolve, methods } = harness({
      get_song_detail_yqq: { track_info: { file: { size_try: 0 } } },
    });
    const { playUrl, sources } = await resolve(`${A},${B}`, 128, undefined, true);
    expect(sources).toEqual([]);
    expect(Object.keys(playUrl)).toEqual([A, B]);
    expect(methods).not.toContain('UrlGetVkey');
  });
});

describe('取播放链接的几种办法', () => {
  it('完整文件是两段文件名，没有 media id 时用 songmid 补第二段', () => {
    const strategy = androidVKeyStrategy(PLAYBACK_FILE_TYPES.flac);
    expect(strategy.id).toBe('android-vkey');
    expect(strategy.filenameOf(A, MEDIA)).toBe(`F000${A}${MEDIA}.flac`);
    expect(strategy.filenameOf(A, '')).toBe(`F000${A}${A}.flac`);
  });

  it('试听文件只有 media id 一段', () => {
    expect(previewRs02Strategy.id).toBe('preview-rs02');
    expect(previewRs02Strategy.filenameOf(A, MEDIA)).toBe(`RS02${MEDIA}.mp3`);
  });

  it('一般请求只会走带会话的完整文件这一条；加密文件那条没有实现', () => {
    const used = Object.entries(PLAYBACK_PROTOCOLS)
      .filter(([, info]) => info.usedByDefault)
      .map(([id]) => id);
    expect(used).toEqual(['android-vkey']);
    expect(PLAYBACK_PROTOCOLS['encrypted-evkey']).toMatchObject({
      implemented: false,
      usedByDefault: false,
      files: 'encrypted',
    });
    expect(PLAYBACK_PROTOCOLS['encrypted-evkey'].evidence).not.toBe('verified-controlled');
  });
});
