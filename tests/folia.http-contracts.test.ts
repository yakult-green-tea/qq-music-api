import type { AxiosRequestConfig } from 'axios';
import type { QrLoginService } from '../src/services/auth/qrLogin';
import type { createContractUpstream } from './helpers/contractUpstream';

let mockUpstream: ReturnType<typeof createContractUpstream>;
let mockNodeService: QrLoginService;

// Keep the real Node adapters and services; replace only the outgoing HTTP executor.
jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  const create = actual.default.create.bind(actual.default);
  actual.default.create = (config: AxiosRequestConfig) =>
    create({ ...config, adapter: (request: AxiosRequestConfig) => mockUpstream.axios(request) });
  return actual;
});
jest.mock('../src/services/auth/qrLogin.node', () => ({
  __esModule: true,
  get default() {
    return mockNodeService;
  },
  get qrLoginService() {
    return mockNodeService;
  },
  configureAuthSessionRepository: (
    repository: Parameters<QrLoginService['configureAuthSessionRepository']>[0],
  ) => mockNodeService.configureAuthSessionRepository(repository),
}));

import request from 'supertest';
import app from '../src/app';
import { createAxiosLegacyTransport } from '../src/node/request';
import { handleRequest, type ServerlessEnv } from '../src/serverless';
import { deriveAndroidDevice } from '../src/serverless/derivedDevice';
import { createSealedSessionResolver } from '../src/serverless/sealedResolver';
import { createMemoryDeviceContextRepository } from '../src/services/auth/deviceContext';
import createAuthHttpClient from '../src/services/auth/httpClient';
import {
  createMemoryAuthSessionRepository,
  createQrLoginService,
} from '../src/services/auth/qrLogin';
import { setLegacyHttpTransport } from '../src/services/httpTransport';
import { logger } from '../src/util/logger';
import deviceFixture from './fixtures/contracts/device-v1.json';
import {
  CONTRACT_ALBUMS,
  CONTRACT_CREDENTIAL,
  CONTRACT_NOW,
  CONTRACT_PLAYLISTS,
  CONTRACT_PROFILE,
  CONTRACT_QR_IMAGE,
  CONTRACT_SECRET,
  CONTRACT_SONGS,
  createContractUpstream as makeUpstream,
} from './helpers/contractUpstream';

interface HttpResult {
  status: number;
  body: Record<string, any>;
  headers: Record<string, string | string[]>;
}
interface CallOptions {
  token?: string;
  headers?: Record<string, string>;
  env?: ServerlessEnv;
}

const catalogCases = [
  {
    path: '/getSongInfo/fixture-song-a/42',
    body: { response: { code: 0, songinfo: { code: 0, data: { track_info: CONTRACT_SONGS[0] } } } },
    method: 'get_song_detail_yqq',
    param: { song_mid: 'fixture-song-a', song_id: '42', song_type: 0 },
  },
  {
    path: '/getSongInfo/fixture-song-a',
    body: { response: { code: 0, songinfo: { code: 0, data: { track_info: CONTRACT_SONGS[0] } } } },
    method: 'get_song_detail_yqq',
    param: { song_mid: 'fixture-song-a', song_id: '', song_type: 0 },
  },
  {
    path: '/getSingerAlbum?singermid=fixture-artist&limit=2&page=3',
    body: { response: { code: 0, singer: { code: 0, data: { list: CONTRACT_ALBUMS } } } },
    method: 'GetAlbumList',
    param: { singermid: 'fixture-artist', num: 2, begin: 3, sort: 5 },
  },
  {
    path: '/getSingerHotsong?singermid=fixture-artist&limit=2&page=3',
    body: { response: { code: 0, singer: { code: 0, data: { songlist: CONTRACT_SONGS } } } },
    method: 'get_singer_detail_info',
    param: { singermid: 'fixture-artist', num: 2, sin: 4, sort: 5 },
  },
] as const;

const userCases = [
  { path: '/user/detail', body: { code: 200, profile: CONTRACT_PROFILE } },
  {
    path: '/user/playlist',
    body: { code: 200, playlist: CONTRACT_PLAYLISTS, total: 1, more: false },
  },
  {
    path: '/user/albums?offset=0&limit=1',
    body: { code: 200, albums: CONTRACT_ALBUMS, total: 1, more: false },
  },
  {
    path: '/user/liked-songs?offset=1&limit=1',
    body: { code: 200, songs: [CONTRACT_SONGS[1]], total: 3, more: true },
  },
  {
    path: '/user/playlist-detail?tid=70001&dirid=10&offset=1&limit=1',
    body: { code: 200, songs: [CONTRACT_SONGS[1]], total: 3, more: true },
  },
] as const;

// These are characterization tests. Runtime differences are explicit, never silently normalized.
describe.each(['node', 'serverless'] as const)('Folia HTTP contracts: %s', (runtime) => {
  let token: string;
  let call: (path: string, options?: CallOptions) => Promise<HttpResult>;

  beforeEach(async () => {
    jest.spyOn(Date, 'now').mockReturnValue(CONTRACT_NOW);
    jest.spyOn(logger, 'error').mockImplementation(() => undefined);
    mockUpstream = makeUpstream();
    jest.spyOn(global, 'fetch').mockImplementation(mockUpstream.fetch);
    const device = await deriveAndroidDevice(CONTRACT_SECRET);
    const session = {
      token: 'a'.repeat(64),
      credential: CONTRACT_CREDENTIAL,
      device: deviceFixture.device,
      expiresAt: CONTRACT_NOW + 3600000,
    };
    mockNodeService = createQrLoginService({
      http: createAuthHttpClient(),
      createSessionHttp: createAuthHttpClient,
      authSessionRepository: createMemoryAuthSessionRepository([session]),
      deviceRepository: createMemoryDeviceContextRepository(device),
      listen: mockUpstream.listen,
    });
    token =
      runtime === 'node'
        ? session.token
        : await createSealedSessionResolver({ secrets: { current: CONTRACT_SECRET } }).issue(
            session,
          );
    app.silent = true;
    call = async (path, options = {}) => {
      const headers = { ...options.headers };
      if (options.token) headers['X-QQ-Session'] = options.token;
      if (runtime === 'node') {
        setLegacyHttpTransport(createAxiosLegacyTransport());
        const result = await request(app.callback()).get(path).set(headers);
        return { status: result.status, body: result.body, headers: result.headers };
      }
      const result = await handleRequest(
        new Request(`https://contract.invalid${path}`, { headers }),
        options.env ?? { QQ_SESSION_SECRET: CONTRACT_SECRET },
        { qqRelay: mockUpstream.relay },
      );
      return {
        status: result.status,
        body: (await result.json()) as HttpResult['body'],
        headers: Object.fromEntries(result.headers),
      };
    };
  });

  afterEach(async () => {
    await mockNodeService.logout();
    jest.restoreAllMocks();
  });

  const startQr = async (channel = 'qq') => {
    const key = await call(`/login/qr/key?channel=${channel}`);
    expect(key.status).toBe(200);
    expect(key.body).toEqual({ code: 200, data: { unikey: expect.any(String) } });
    const unikey = key.body.data.unikey as string;
    const image = await call(`/login/qr/create?key=${encodeURIComponent(unikey)}`);
    expect(image.status).toBe(200);
    expect(image.body).toEqual({ code: 200, data: { qrimg: CONTRACT_QR_IMAGE } });
    return unikey;
  };

  it.each(catalogCases)('keeps the catalog envelope and parameters for $path', async (fixture) => {
    const result = await call(fixture.path);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject(fixture.body);
    expect(mockUpstream.calls).toContainEqual(
      expect.objectContaining({ method: fixture.method, param: fixture.param }),
    );
  });

  it('keeps the album payload at response.data and reads the query parameter', async () => {
    const result = await call('/getAlbumInfo?albummid=fixture-album');
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ response: { code: 0, data: { list: CONTRACT_SONGS } } });
    expect(mockUpstream.requests[0].searchParams.get('albummid')).toBe('fixture-album');
  });

  it('keeps public playlist metadata and songs at response.cdlist', async () => {
    const result = await call('/getSongListDetail/70001');
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      response: {
        code: 0,
        cdlist: [{ dissname: 'Fixture playlist', songlist: CONTRACT_SONGS, total_song_num: 3 }],
      },
    });
    expect(mockUpstream.requests[0].searchParams.get('disstid')).toBe('70001');
  });

  it.each([
    '/getAlbumInfo?albummid=fixture-album',
    '/getSingerAlbum?singermid=fixture-artist',
    '/getSingerHotsong?singermid=fixture-artist',
    '/getSongListDetail/70001',
  ])('keeps a catalog rejection inside HTTP 200 for %s', async (path) => {
    mockUpstream.state.catalogCode = 500003;
    const result = await call(path);
    expect(result.status).toBe(200);
    if (path.startsWith('/getSinger')) expect(result.body.response.singer.code).toBe(500003);
    else expect(result.body.response.code).toBe(500003);
  });

  it.each(userCases)('keeps the authenticated payload for $path', async (fixture) => {
    const result = await call(fixture.path, { token });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject(fixture.body);
    expect(JSON.stringify(result.body)).not.toContain(CONTRACT_CREDENTIAL.musickey);
    expect(JSON.stringify(result.body)).not.toContain(CONTRACT_CREDENTIAL.encryptUin);
  });

  it('passes playlist identifiers and pagination to the owned read', async () => {
    await call('/user/playlist-detail?tid=70001&dirid=10&offset=1&limit=2', { token });
    expect(mockUpstream.calls).toContainEqual(
      expect.objectContaining({
        method: 'CgiGetDiss',
        param: {
          disstid: 70001,
          dirid: 10,
          song_begin: 1,
          song_num: 2,
          enc_host_uin: CONTRACT_CREDENTIAL.encryptUin,
          tag: true,
          userinfo: true,
          orderlist: true,
        },
      }),
    );
  });

  it('reads liked songs from directory 201 with bounded pagination', async () => {
    await call('/user/liked-songs?offset=-4&limit=200', { token });
    expect(mockUpstream.calls).toContainEqual(
      expect.objectContaining({
        method: 'CgiGetDiss',
        param: expect.objectContaining({ dirid: 201, disstid: 0, song_begin: 0, song_num: 100 }),
      }),
    );
  });

  it('keeps authenticated playback URLs keyed by songmid', async () => {
    const result = await call('/getMusicPlay/fixture-song-a?quality=320&mediaId=fixture-media', {
      token,
    });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      data: {
        playUrl: {
          'fixture-song-a': {
            url: 'https://stream.invalid/fixture.mp3',
            error: false,
            source: { kind: 'full', protocol: 'android-vkey', cdn: 'response-sip' },
          },
        },
      },
    });
    expect(mockUpstream.calls).toContainEqual(
      expect.objectContaining({
        method: 'UrlGetVkey',
        param: expect.objectContaining({
          filename: ['M800fixture-song-afixture-media.mp3'],
          songmid: ['fixture-song-a'],
        }),
      }),
    );
  });

  // 开发日志：取不到链接的那几首各记一条，只带白名单里的安全整数；回应只多可选的 restriction。
  it('adds an optional restriction and logs safe numbers for each failed song', async () => {
    const debug = jest.spyOn(logger, 'debug').mockImplementation(() => undefined);
    mockUpstream.state.vkeyItems = {
      'fixture-song-b': {
        purl: '',
        result: 104003,
        errtype: '3',
        code: 0,
        vkey: 'fixture-private-vkey',
        tips: 'fixture-private-tip',
        opi30surl: 'https://fixture-private-url/',
        filename: 'fixture-private-file',
      },
      'fixture-song-c': { purl: '', result: 1.5, code: 2 ** 60, subcode: 'abc', errtype: { n: 1 } },
    };
    mockUpstream.state.songDetails = {
      'fixture-song-b': { mid: 'fixture-song-b', action: { msgid: 23 }, pay: { pay_play: 0 } },
    };

    const result = await call('/getMusicPlay/fixture-song-a,fixture-song-b,fixture-song-c', {
      token,
    });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      data: {
        playUrl: {
          'fixture-song-a': {
            url: 'https://stream.invalid/fixture.mp3',
            error: false,
            source: { kind: 'full', protocol: 'android-vkey', cdn: 'response-sip' },
          },
          'fixture-song-b': {
            url: '',
            error: '暂无播放链接',
            restriction: {
              key: 'url_unavailable',
              evidence: 'observed-response',
              codes: { result: 104003, errtype: 3, code: 0 },
              hint: { key: 'playback.reason-unconfirmed', message: expect.any(String) },
            },
            source: { kind: 'full', protocol: 'android-vkey', cdn: 'none' },
          },
          'fixture-song-c': {
            url: '',
            error: '暂无播放链接',
            restriction: {
              key: 'url_unavailable',
              evidence: 'observed-response',
              hint: { key: 'playback.reason-unconfirmed', message: expect.any(String) },
            },
            source: { kind: 'full', protocol: 'android-vkey', cdn: 'none' },
          },
        },
      },
    });
    const events = debug.mock.calls
      .filter(([event]) => event === 'playback.url-unavailable')
      .map(([, meta]) => meta);
    // 只记阶段、位置、音质和安全错码，不记歌曲 id：靠 index 对上是请求里的第几首。
    expect(events).toEqual([
      {
        phase: 'get-music-play',
        index: 1,
        quality: '128',
        entryCodes: { result: 104003, errtype: 3, code: 0 },
      },
      { phase: 'get-music-play', index: 2, quality: '128', entryCodes: {} },
    ]);
    expect(JSON.stringify(events)).not.toMatch(/fixture-song-[abc]/);
    const logged = JSON.stringify(debug.mock.calls);
    for (const secret of [
      'fixture-private',
      'fixture.mp3',
      CONTRACT_CREDENTIAL.musickey,
      CONTRACT_CREDENTIAL.encryptUin,
      CONTRACT_CREDENTIAL.str_musicid,
    ])
      expect(logged).not.toContain(secret);
  });

  it('logs nothing for playback when every song has a link', async () => {
    const debug = jest.spyOn(logger, 'debug').mockImplementation(() => undefined);
    const result = await call('/getMusicPlay/fixture-song-a,fixture-song-b', { token });
    expect(result.status).toBe(200);
    expect(debug.mock.calls.filter(([event]) => event === 'playback.url-unavailable')).toEqual([]);
  });

  it.each(userCases)('answers 401 without a session for $path', async (fixture) => {
    const result = await call(fixture.path);
    expect(result.status).toBe(401);
    expect(result.body).toEqual({ code: 401, message: 'Login required' });
    expect(mockUpstream.calls).toEqual([]);
  });

  it.each([
    1000, 104400, 104401,
  ])('maps only an existing credential rejection %i to 401', async (code) => {
    mockUpstream.state.credentialCode = code;
    const result = await call('/user/detail', { token });
    expect(result.status).toBe(401);
    expect(result.body.code).toBe(401);
    const status = await call('/login/status', { token });
    expect(status.status).toBe(200);
    expect(status.body).toEqual({ code: 200, data: {} });
  });

  // 新的推荐路由出错时，不能顺带清掉会话或让扫码进入冷却。
  it.each([
    [{ recommendCode: 1000 }, 401],
    [{ recommendCode: 2001 }, 502],
    [{ recommendCode: 22006 }, 502],
    [{ recommendHttpStatus: 429 }, 429],
    [{ recommendEmpty: true }, 422],
  ] as const)('keeps the session and QR login usable after a new route answers %p', async (failure, status) => {
    Object.assign(mockUpstream.state, failure);
    expect((await call('/user/guess-you-like', { token })).status).toBe(status);
    expect((await call('/recommend/playlists', { token })).status).toBe(status);
    Object.assign(mockUpstream.state, {
      recommendCode: 0,
      recommendEmpty: false,
      recommendHttpStatus: 0,
    });

    const detail = await call('/user/detail', { token });
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({ code: 200, profile: CONTRACT_PROFILE });
    await startQr('wechat');
  });

  it('keeps an unfamiliar upstream business failure out of 401 and 404', async () => {
    mockUpstream.state.credentialCode = 20279;
    const result = await call('/user/detail', { token });
    expect(result.status).toBe(500);
  });

  it('keeps login status at 200 with an empty data when logged out', async () => {
    const result = await call('/login/status');
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ code: 200, data: {} });
  });

  it('keeps a restored profile at data.profile', async () => {
    const result = await call('/login/status', { token });
    expect(result.body).toEqual({ code: 200, data: { profile: CONTRACT_PROFILE } });
  });

  it.each([
    'query',
    'header',
    'cookie',
  ] as const)('accepts a valid session via %s', async (source) => {
    const path =
      source === 'query'
        ? `/user/detail?cookie=${encodeURIComponent(`qqmusic_session=${token}`)}`
        : '/user/detail';
    const headers: Record<string, string> =
      source === 'header'
        ? { 'X-QQ-Session': token }
        : source === 'cookie'
          ? { Cookie: `qqmusic_session=${token}` }
          : {};
    const result = await call(path, { headers });
    expect(result.status).toBe(200);
    expect(result.body.profile).toEqual(CONTRACT_PROFILE);
  });

  it('gives the header priority over a valid query and cookie session', async () => {
    const result = await call(
      `/user/detail?cookie=${encodeURIComponent(`qqmusic_session=${token}`)}`,
      { headers: { 'X-QQ-Session': 'invalid-token', Cookie: `qqmusic_session=${token}` } },
    );
    expect(result.status).toBe(401);
    expect(mockUpstream.calls).toEqual([]);
  });

  it('gives a query session priority over a valid cookie', async () => {
    const result = await call('/user/detail?cookie=qqmusic_session%3Dinvalid-token', {
      headers: { Cookie: `qqmusic_session=${token}` },
    });
    expect(result.status).toBe(401);
  });

  it.each([
    '/login/qr/create',
    '/login/qr/check',
    '/login/qr/cancel',
  ])('requires a key on %s', async (path) => {
    const result = await call(path);
    expect(result.status).toBe(400);
    expect(result.body).toEqual({ code: 400, message: 'key is required' });
  });

  it('keeps cancellation idempotent for unknown keys', async () => {
    for (let index = 0; index < 2; index++) {
      const result = await call('/login/qr/cancel?key=fixture-unknown-key');
      expect(result.status).toBe(200);
      expect(result.body).toEqual({ code: 200 });
    }
  });

  it('keeps unknown QR checks naturally expired without failure metadata', async () => {
    const result = await call('/login/qr/check?key=fixture-unknown-key');
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ code: 800, message: 'QR code expired' });
  });

  it('keeps the QR lifetime, waiting and scanned states', async () => {
    const key = await startQr();
    expect(mockUpstream.opened).toEqual([{ id: 'fixture-qr-id', ttl: 180000 }]);
    const path = `/login/qr/check?key=${encodeURIComponent(key)}`;
    const waiting = await call(path);
    expect(waiting.body.code).toBe(801);
    await mockUpstream.observe({ type: 'scanned', payload: null });
    const scanned = await call(path);
    expect(scanned.body.code).toBe(802);
  });

  it('keeps the legacy mobile channel on the mobile QQ protocol', async () => {
    const result = await call('/login/qr/key?channel=mobile');
    expect(result.status).toBe(200);
    const key = result.body.data.unikey;
    await call(`/login/qr/create?key=${encodeURIComponent(key)}`);
    expect(mockUpstream.opened.at(-1)?.id).toBe('fixture-qr-id');
  });

  it("preserves each runtime's default QR channel", async () => {
    const result = await call('/login/qr/key');
    expect(result.status).toBe(200);
    await call(`/login/qr/create?key=${encodeURIComponent(result.body.data.unikey)}`);
    expect(mockUpstream.calls.some((rpc) => rpc.method === 'CreateQRCode')).toBe(
      runtime === 'node',
    );
    if (runtime === 'serverless')
      expect(mockUpstream.requests.some((url) => url.pathname === '/connect/qrconnect')).toBe(true);
  });

  it('keeps successful QR checks at 803 with an opaque cookie', async () => {
    const key = await startQr();
    await mockUpstream.observe({
      type: 'cookies',
      payload: {
        cookies: {
          qqmusic_uin: { value: '10000' },
          qqmusic_key: { value: 'fixture-exchange-token' },
        },
      },
    });
    const result = await call(`/login/qr/check?key=${encodeURIComponent(key)}`);
    expect(result.status).toBe(200);
    expect(result.body.code).toBe(803);
    expect(result.body.cookie).toMatch(/^qqmusic_session=\S+$/);
    const signedIn = await call(`/login/status?cookie=${encodeURIComponent(result.body.cookie)}`);
    expect(signedIn.body.data.profile).toEqual(CONTRACT_PROFILE);
    const exchange = mockUpstream.calls.find((rpc) => rpc.method === 'Login');
    expect(exchange?.comm.tmeLoginType).toBe(6);
    expect(exchange?.param).toMatchObject({
      qrCodeID: 'fixture-qr-id',
      token: 'fixture-exchange-token',
    });
    expect(JSON.stringify(result.body)).not.toContain(CONTRACT_CREDENTIAL.musickey);
  });

  it('keeps WeChat exchange on tmeLoginType 1', async () => {
    const key = await startQr('wechat');
    mockUpstream.state.wechatCode = 405;
    const result = await call(`/login/qr/check?key=${encodeURIComponent(key)}`);
    expect(result.body.code).toBe(803);
    expect(mockUpstream.calls.find((rpc) => rpc.method === 'Login')?.comm.tmeLoginType).toBe(1);
  });

  it.each([
    'timeout',
    'canceled',
    'loginFailed',
  ] as const)('preserves the terminal QR meaning for %s', async (event) => {
    const key = await startQr();
    await mockUpstream.observe({ type: event, payload: null });
    const result = await call(`/login/qr/check?key=${encodeURIComponent(key)}`);
    expect(result.status).toBe(200);
    expect(result.body.code).toBe(800);
    expect(result.body.failureReason).toBe(
      { timeout: 'qr-timeout', canceled: 'user-canceled', loginFailed: 'login-rejected' }[event],
    );
  });

  it('expires a QR naturally after 180 seconds without failure fields', async () => {
    const key = await startQr();
    jest.spyOn(Date, 'now').mockReturnValue(CONTRACT_NOW + 180001);
    const result = await call(`/login/qr/check?key=${encodeURIComponent(key)}`);
    expect(result.body).toEqual({ code: 800, message: 'QR code expired' });
  });

  it('keeps safe bootstrap failures and the Retry-After cooldown', async () => {
    mockUpstream.state.bootstrapStatus = 503;
    const result = await call('/login/qr/key?channel=wechat');
    expect(result.status).toBe(502);
    expect(result.headers['retry-after']).toBe('15');
    expect(result.body).toMatchObject({
      code: 502,
      retryAfterMs: 15000,
      failureStage: 'device-bootstrap',
      failureReason: 'upstream-http-error',
      upstreamHttpStatus: 503,
    });
    expect(JSON.stringify(result.body)).not.toContain('fixture-private-upstream-body');
    if (runtime === 'node') {
      const retry = await call('/login/qr/key?channel=wechat');
      expect(retry.status).toBe(429);
      expect(retry.headers['retry-after']).toBe('15');
      expect(retry.body.retryAfterMs).toBe(15000);
    }
  });

  it('keeps logout successful and expires the browser cookie', async () => {
    const result = await call('/logout', { token });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ code: 200 });
    expect(String(result.headers['set-cookie'])).toContain('qqmusic_session=;');
    if (runtime === 'node') expect((await call('/user/detail', { token })).status).toBe(401);
  });

  it('keeps the capability fields while allowing Node to add the missing route', async () => {
    const result = await call('/login/channels');
    // The Node route is an approved compatible addition. Its current absence triggers Folia's fallback.
    if (runtime === 'node' && result.status === 404) {
      expect(result.body).toEqual({});
      expect(mockUpstream.requests).toEqual([]);
      return;
    }
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      code: 200,
      data: {
        // Folia 只留自己认得的 qq、wechat，多出来的 qqmusic 不会出现在它的登录选项里。
        channels: ['qq', 'wechat', 'qqmusic'],
        sessionMode: runtime === 'node' ? 'stored' : 'sealed',
        configured: true,
      },
    });
  });
});
