import type { AxiosRequestConfig, AxiosResponse } from 'axios';
import request from 'supertest';
import app from '../src/app';
import { handleRequest, type ServerlessEnv } from '../src/serverless';
import { deriveAndroidDevice } from '../src/serverless/derivedDevice';
import { createFetchLegacyTransport } from '../src/serverless/fetchLegacyTransport';
import { createSealedSessionResolver } from '../src/serverless/sealedResolver';
import { createAndroidDevice } from '../src/services/auth/androidDevice';
import type { AuthHttpClient } from '../src/services/auth/httpClient';
import {
  type AuthSession,
  createQrLoginService,
  type SessionResolver,
} from '../src/services/auth/qrLogin';
import qrLoginService from '../src/services/auth/qrLogin.node';
import { type LegacyHttpTransport, setLegacyHttpTransport } from '../src/services/httpTransport';
import aiDissInfo211111 from './fixtures/official-playlists/ai-dissinfo-211111.json';
import aiDissInfo211192 from './fixtures/official-playlists/ai-dissinfo-211192.json';
import aiDissInfoDailyLimit1 from './fixtures/official-playlists/ai-dissinfo-daily-limit-1.json';
import fcgCode10 from './fixtures/official-playlists/fcg-code-10.json';
import createdPlaylists from './fixtures/official-playlists/user-playlist-created.json';
import favoritePlaylists from './fixtures/official-playlists/user-playlist-favorites.json';

// serverless 这一侧的 /getSongListDetail 与 /user/playlist：真的 sealed token、真的 service，
// `global.fetch` 代替上游。最后一组把同一份假上游同时喂给 Koa 与 serverless，两边的回应必须一模一样。

const SECRET = 'a-deployment-secret';
const FCG_PATH = '/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg';
const MUSICU_URL = 'https://u.y.qq.com/cgi-bin/musicu.fcg';
const DAILY_TID = 9000000030;
const PUBLIC_PLAYLIST = {
  code: 0,
  cdlist: [{ disstid: '7011264340', dissname: '公开歌单', songlist: [{ mid: 'public-song' }] }],
};
const ALGORITHMIC_TIDS = new Set(['211192', '211111']);

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const envelope = (data: unknown, code = 0) => ({ code: 0, req_0: { code, data } });

/** 两个 runtime 共用的假上游。`dissCode` 非 0 时 uniform_get_Dissinfo 一律回这个码。 */
const upstream = {
  dissCode: 0,
  fcg: (disstid: string | null) =>
    ALGORITHMIC_TIDS.has(String(disstid)) ? clone(fcgCode10) : clone(PUBLIC_PLAYLIST),
  musicu: (method: string, param: Record<string, any>) => {
    if (method === 'GetPlaylistByUin') return envelope(clone(createdPlaylists));
    if (method === 'CgiGetPlaylistFavInfo') return envelope(clone(favoritePlaylists));
    if (method !== 'uniform_get_Dissinfo') throw new Error(`Unexpected method: ${method}`);
    if (upstream.dissCode) return envelope({}, upstream.dissCode);
    if (param.disstid === 211192) return clone(aiDissInfo211192);
    if (param.disstid === 211111) return clone(aiDissInfo211111);
    if (param.disstid === DAILY_TID) return clone(aiDissInfoDailyLimit1);
    return envelope({}, 10004);
  },
};

interface Recorded {
  fcg: { disstid: string | null; headers: Record<string, string> }[];
  musicu: { method: string; param: Record<string, any> }[];
}
let recorded: Recorded;
let originalFetch: typeof fetch;

const call = (
  path: string,
  init: RequestInit = {},
  env: ServerlessEnv = { QQ_SESSION_SECRET: SECRET },
) => handleRequest(new Request(`https://worker.invalid${path}`, init), env);

const sealedToken = async (secret = SECRET) =>
  createSealedSessionResolver({ secrets: { current: secret } }).issue({
    credential: {
      musicid: '10000',
      musickey: 'musickey-value',
      loginType: 1,
      encryptUin: 'encrypted-uin',
    },
    device: await deriveAndroidDevice(secret),
    expiresAt: Date.now() + 3_600_000,
  });

const dissCalls = () => recorded.musicu.filter((entry) => entry.method === 'uniform_get_Dissinfo');

beforeEach(() => {
  recorded = { fcg: [], musicu: [] };
  upstream.dissCode = 0;
  originalFetch = global.fetch;
  global.fetch = jest.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (url.host === 'c.y.qq.com' && url.pathname === FCG_PATH) {
      const headers: Record<string, string> = {};
      req.headers.forEach((value, name) => {
        headers[name] = value;
      });
      recorded.fcg.push({ disstid: url.searchParams.get('disstid'), headers });
      return new Response(JSON.stringify(upstream.fcg(url.searchParams.get('disstid'))));
    }
    if (`${url.origin}${url.pathname}` === MUSICU_URL) {
      const payload = JSON.parse(String(init?.body ?? '{}'));
      recorded.musicu.push({ method: payload.req_0.method, param: payload.req_0.param });
      return new Response(
        JSON.stringify(upstream.musicu(payload.req_0.method, payload.req_0.param)),
      );
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
  jest.restoreAllMocks();
});

describe('serverless /getSongListDetail：算法歌单用凭据重读', () => {
  it('没有会话：原样返回 code 10，不打 musicu', async () => {
    const response = await call('/getSongListDetail/211192');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ response: fcgCode10 });
    expect(recorded.musicu).toEqual([]);
  });

  it('部署没设 QQ_SESSION_SECRET：带着会话也原样返回，不是 501 或 500', async () => {
    const response = await call(
      '/getSongListDetail/211192',
      { headers: { 'X-QQ-Session': await sealedToken() } },
      {},
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ response: fcgCode10 });
    expect(recorded.musicu).toEqual([]);
  });

  it('带着会话：返回改写后的歌单，会话不会被带去匿名 CGI', async () => {
    const token = await sealedToken();

    const response = await call('/getSongListDetail/211192', {
      headers: { 'X-QQ-Session': token },
    });
    const body = (await response.json()) as Record<string, any>;

    expect(response.status).toBe(200);
    expect(body.response.cdlist[0]).toMatchObject({
      disstid: '211192',
      dissname: '歌手漫游 | 专享歌手Mix',
      total_song_num: 50,
    });
    expect(dissCalls().map((entry) => [entry.param.disstid, entry.param.song_num])).toEqual([
      [211192, 1000],
    ]);
    expect(JSON.stringify(recorded.fcg)).not.toContain(token);
  });

  it('会话放在 ?cookie= 参数里也一样', async () => {
    const cookie = encodeURIComponent(`qqmusic_session=${await sealedToken()}`);

    const response = await call(`/getSongListDetail/211192?cookie=${cookie}`);

    expect(((await response.json()) as Record<string, any>).response.code).toBe(0);
  });

  it('别的部署封出来的会话：原样返回 code 10，不打 musicu', async () => {
    const response = await call('/getSongListDetail/211192', {
      headers: { 'X-QQ-Session': await sealedToken('another-deployment-secret') },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ response: fcgCode10 });
    expect(recorded.musicu).toEqual([]);
  });

  it('上游拒绝凭据：仍是 200 加原来的 code 10，不是 401', async () => {
    upstream.dissCode = 1000;

    const response = await call('/getSongListDetail/211192', {
      headers: { 'X-QQ-Session': await sealedToken() },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ response: fcgCode10 });
  });

  it('普通歌单（code 0）带着会话也不重读', async () => {
    const response = await call('/getSongListDetail/7011264340', {
      headers: { 'X-QQ-Session': await sealedToken() },
    });

    expect(await response.json()).toEqual({ response: PUBLIC_PLAYLIST });
    expect(recorded.musicu).toEqual([]);
  });
});

describe('serverless /user/playlist：歌单封面', () => {
  it('官方歌单换成第一首歌的专辑封面，普通收藏沿用原本的封面，自建歌单原样', async () => {
    const response = await call('/user/playlist', {
      headers: { 'X-QQ-Session': await sealedToken() },
    });
    const body = (await response.json()) as Record<string, any>;

    expect(response.status).toBe(200);
    expect(body.total).toBe(7);
    expect(body.playlist.map((entry: Record<string, unknown>) => entry.picUrl)).toEqual([
      createdPlaylists.v_playlist[0].picUrl,
      createdPlaylists.v_playlist[1].picUrl,
      'https://y.gtimg.cn/music/photo_new/T002R300x300M000000FixAlbum007.jpg?max_age=2592000',
      'https://y.gtimg.cn/music/photo_new/T002R300x300M000000FixAlbum001.jpg?max_age=2592000',
      'https://y.gtimg.cn/music/photo_new/T002R300x300M000000FixAlbum004.jpg?max_age=2592000',
      'https://y.qq.com/fixture/custom-cover-1.jpg',
      'https://y.qq.com/fixture/custom-cover-2.jpg',
    ]);
    expect(body.playlist.slice(0, 2)).toEqual(createdPlaylists.v_playlist);
    expect(body.playlist.slice(5)).toEqual(
      favoritePlaylists.v_list
        .slice(3)
        .map((entry) => ({ ...entry, bigpicUrl: entry.logo, picUrl: entry.logo })),
    );
  });
});

// 同一份假上游分别喂给 Koa 与 serverless。Koa 一侧的匿名 CGI 走注册的 legacy transport，带凭据的读取
// 由一个接同一份假上游的 service 代答；两侧回应（状态码与 body）必须完全相同。
describe('Node 与 serverless 的回应一致', () => {
  const NODE_TOKEN = 'node-session-token';
  const koa = app.callback();

  const nodeSession: AuthSession = {
    token: NODE_TOKEN,
    credential: {
      musicid: '10000',
      musickey: 'musickey-value',
      loginType: 1,
      encryptUin: 'encrypted-uin',
    },
    device: createAndroidDevice(),
    expiresAt: Date.now() + 3_600_000,
  };
  const nodeResolver: SessionResolver = {
    mode: 'stored',
    issue: async () => NODE_TOKEN,
    resolve: async (token) => (token === NODE_TOKEN ? nodeSession : null),
    revoke: async () => undefined,
  };
  const nodeHttp = {
    getCookieHeader: () => '',
    request: jest.fn(),
    post: async (_url: string, payload: any) =>
      ({
        data: upstream.musicu(payload.req_0.method, payload.req_0.param),
        status: 200,
      }) as AxiosResponse,
  } as unknown as AuthHttpClient;
  const nodeTwin = createQrLoginService({ http: nodeHttp, sessionResolver: nodeResolver });

  const fakeLegacyTransport: LegacyHttpTransport = {
    kind: 'test',
    defaults: createFetchLegacyTransport().defaults,
    request: async <T>(_url: string, _method: string, options: AxiosRequestConfig = {}) =>
      ({
        data: upstream.fcg(String((options.params as Record<string, unknown>)?.disstid)),
        status: 200,
      }) as AxiosResponse<T>,
  };

  const callKoa = async (path: string) => {
    // serverless 每次调用都会改注册 fetch transport，所以 Koa 的请求前重新注册一次
    setLegacyHttpTransport(fakeLegacyTransport);
    const response = await request(koa).get(path).set('X-QQ-Session', NODE_TOKEN);
    return { status: response.status, body: response.body };
  };
  const callServerless = async (path: string) => {
    const response = await call(path, { headers: { 'X-QQ-Session': await sealedToken() } });
    return { status: response.status, body: await response.json() };
  };

  beforeEach(() => {
    jest
      .spyOn(qrLoginService, 'getAuthenticatedSongListDetail')
      .mockImplementation((token, disstid, options) =>
        nodeTwin.getAuthenticatedSongListDetail(token, disstid, options),
      );
    jest
      .spyOn(qrLoginService, 'getUserPlaylists')
      .mockImplementation((token, uin) => nodeTwin.getUserPlaylists(token, uin));
  });

  it.each([
    ['普通歌单', '/getSongListDetail/7011264340', 0],
    ['算法歌单，重读成功', '/getSongListDetail/211192', 0],
    ['算法歌单，凭据被拒', '/getSongListDetail/211111', 1000],
    ['我的歌单', '/user/playlist', 0],
  ])('%s', async (_label, path, dissCode) => {
    upstream.dissCode = dissCode;

    const node = await callKoa(path);
    const serverless = await callServerless(path);

    expect(serverless).toEqual(node);
    expect(node.status).toBe(200);
  });
});
