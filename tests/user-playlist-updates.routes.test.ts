import type { QrLoginService } from '../src/services/auth/qrLogin';

let mockNodeService: QrLoginService;

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
import { handleRequest, type ServerlessEnv } from '../src/serverless';
import { deriveAndroidDevice } from '../src/serverless/derivedDevice';
import { createSealedSessionResolver } from '../src/serverless/sealedResolver';
import { createMemoryDeviceContextRepository } from '../src/services/auth/deviceContext';
import createAuthHttpClient from '../src/services/auth/httpClient';
import {
  createMemoryAuthSessionRepository,
  createQrLoginService,
} from '../src/services/auth/qrLogin';
import { logger } from '../src/util/logger';
import deviceFixture from './fixtures/contracts/device-v1.json';
import { CONTRACT_CREDENTIAL, CONTRACT_NOW, CONTRACT_SECRET } from './helpers/contractUpstream';

// 收藏歌单有更新（`FavDissRecentUpdate.CgiGetRecentSong`）：要登录，只读。Node 与 serverless 跑同一份案例。
// 先读收藏歌单第一页（最多 100 个，`PlaylistFavRead.CgiGetPlaylistFavInfo`），再把它们的 disstid 连同
// rtime 0 送上去。形状按 2026-11 带会话实测：`{ code, subcode, msg, updateDirs: [{ disstid, update_songnum,
// update_time, modeMask, recent_song: [{ id, name, singer: [string] }] }] }`，只回有更新的歌单。
// rtime 固定 0 时 update_songnum 的确切意思还没有对照证据。名称与 id 都是假数据。

interface Rpc {
  module: string;
  method: string;
  param: Record<string, unknown>;
}
interface Recorded {
  comm: Record<string, unknown>;
  cookie: string | null;
  rpcs: Rpc[];
}
interface Reply {
  httpStatus?: number;
  globalCode?: number;
  code?: number;
  data?: unknown;
}
interface HttpResult {
  status: number;
  headers: Record<string, string | undefined>;
  body: Record<string, any>;
}

const favorite = (tid: number, overrides: Record<string, unknown> = {}) => ({
  tid,
  dirId: 0,
  dirType: 0,
  name: `Fixture favorite ${tid}`,
  ...overrides,
});
const FAVORITES = {
  code: 0,
  total: 3,
  hasmore: 0,
  v_list: [favorite(8001), favorite(8002, { dirId: 7 }), favorite(8003)],
};
const updateDir = (disstid: unknown, overrides: Record<string, unknown> = {}) => ({
  disstid,
  update_songnum: 4,
  update_time: 1790000100,
  modeMask: 3,
  recent_song: [
    { id: 501, name: 'Fixture new song', singer: ['Fixture singer A', 'Fixture singer B'] },
  ],
  ...overrides,
});
const UPDATES = {
  code: 0,
  subcode: 0,
  msg: '',
  ct: 11,
  cv: 0,
  uin: 10000,
  encrypt_uin: 'fixture-private-encrypted',
  srf_ip: 'fixture-private-ip',
  updateDirs: [updateDir(8001), updateDir(8003, { update_songnum: 1, recent_song: [] })],
};

describe.each(['node', 'serverless'] as const)('playlist updates route: %s', (runtime) => {
  let token: string;
  let recorded: Recorded[];
  let replies: Record<string, Reply>;
  let call: (
    path: string,
    options?: { token?: string; env?: ServerlessEnv },
  ) => Promise<HttpResult>;

  const upstream = async (input: string | URL | Request, init?: RequestInit) => {
    const fetched = new Request(input, init);
    const url = new URL(fetched.url);
    if (url.hostname !== 'u.y.qq.com' || url.pathname !== '/cgi-bin/musicu.fcg')
      throw new Error(`Unstubbed request: ${url.origin}${url.pathname}`);
    const payload = JSON.parse(await fetched.text());
    const rpcs: Rpc[] = Object.entries(payload)
      .filter(([key]) => key.startsWith('req_'))
      .map(([, value]) => value as Rpc);
    recorded.push({ comm: payload.comm, cookie: fetched.headers.get('cookie'), rpcs });
    const reply = replies[rpcs[0]?.method] ?? {};
    if (reply.httpStatus && reply.httpStatus >= 400)
      return new Response('fixture-private-error-page', { status: reply.httpStatus });
    return Response.json({
      code: reply.globalCode ?? 0,
      req_0: { code: reply.code ?? 0, data: reply.data ?? {} },
    });
  };

  beforeEach(async () => {
    jest.spyOn(Date, 'now').mockReturnValue(CONTRACT_NOW);
    for (const level of ['debug', 'warn', 'error'] as const)
      jest.spyOn(logger, level).mockImplementation(() => undefined);
    jest.spyOn(global, 'fetch').mockImplementation(upstream);
    recorded = [];
    replies = {
      CgiGetPlaylistFavInfo: { data: FAVORITES },
      CgiGetRecentSong: { data: UPDATES },
    };
    const session = {
      token: 'b'.repeat(64),
      credential: CONTRACT_CREDENTIAL,
      device: deviceFixture.device,
      expiresAt: CONTRACT_NOW + 3600000,
    };
    mockNodeService = createQrLoginService({
      http: createAuthHttpClient(),
      createSessionHttp: createAuthHttpClient,
      authSessionRepository: createMemoryAuthSessionRepository([session]),
      deviceRepository: createMemoryDeviceContextRepository(
        await deriveAndroidDevice(CONTRACT_SECRET),
      ),
    });
    token =
      runtime === 'node'
        ? session.token
        : await createSealedSessionResolver({ secrets: { current: CONTRACT_SECRET } }).issue(
            session,
          );
    app.silent = true;
    call = async (path, options = {}) => {
      const headers: Record<string, string> = {};
      if (options.token) headers['X-QQ-Session'] = options.token;
      if (runtime === 'node') {
        const result = await request(app.callback()).get(path).set(headers);
        return { status: result.status, headers: result.headers, body: result.body };
      }
      const result = await handleRequest(
        new Request(`https://updates.invalid${path}`, { headers }),
        options.env ?? { QQ_SESSION_SECRET: CONTRACT_SECRET },
      );
      return {
        status: result.status,
        headers: Object.fromEntries(result.headers.entries()),
        body: (await result.json()) as HttpResult['body'],
      };
    };
  });

  afterEach(async () => {
    await mockNodeService.logout();
    jest.restoreAllMocks();
  });

  it('answers 401 without a session and never reaches the upstream', async () => {
    const result = await call('/user/playlist/updates');

    expect(result.status).toBe(401);
    expect(result.body).toMatchObject({ code: 401, errorKey: 'auth.required' });
    expect(result.headers['cache-control']).toBe('private, no-store');
    expect(recorded).toEqual([]);
  });

  it('treats a token that does not resolve as no session', async () => {
    const result = await call('/user/playlist/updates', { token: 'c'.repeat(64) });

    expect(result.status).toBe(401);
    expect(recorded).toEqual([]);
  });

  it('reads the first favorite page, then asks which of them have new songs', async () => {
    const result = await call('/user/playlist/updates', { token });

    expect(result.status).toBe(200);
    expect(result.headers['cache-control']).toBe('private, no-store');
    expect(result.body).toEqual({
      code: 200,
      playlists: [
        {
          id: 8001,
          newSongCount: 4,
          updateTime: 1790000100,
          latestSong: {
            id: 501,
            name: 'Fixture new song',
            singers: ['Fixture singer A', 'Fixture singer B'],
          },
        },
        { id: 8003, newSongCount: 1, updateTime: 1790000100 },
      ],
      checked: 3,
      complete: true,
    });
    expect(recorded.map((item) => item.rpcs)).toEqual([
      [
        {
          module: 'music.musicasset.PlaylistFavRead',
          method: 'CgiGetPlaylistFavInfo',
          param: { uin: CONTRACT_CREDENTIAL.encryptUin, offset: 0, size: 100 },
        },
      ],
      [
        {
          module: 'music.musicasset.FavDissRecentUpdate',
          method: 'CgiGetRecentSong',
          param: {
            clientOrderDirs: [
              { disstid: 8001, rtime: 0 },
              { disstid: 8002, dirid: 7, rtime: 0 },
              { disstid: 8003, rtime: 0 },
            ],
          },
        },
      ],
    ]);
    for (const item of recorded) expect(item.comm).toMatchObject({ ct: 11 });
    expect(JSON.stringify(result.body)).not.toContain('fixture-private');
  });

  it('says complete:false when the favorites go past the first page', async () => {
    replies.CgiGetPlaylistFavInfo = { data: { ...FAVORITES, hasmore: 1, total: 250 } };

    const result = await call('/user/playlist/updates', { token });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ checked: 3, complete: false });
  });

  it('with no favorite playlists it does not ask the second question', async () => {
    replies.CgiGetPlaylistFavInfo = { data: { ...FAVORITES, total: 0, v_list: [] } };

    const result = await call('/user/playlist/updates', { token });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ code: 200, playlists: [], checked: 0, complete: true });
    expect(recorded).toHaveLength(1);
  });

  it('only counts favorites with a usable id as checked', async () => {
    replies.CgiGetPlaylistFavInfo = {
      data: { ...FAVORITES, v_list: [null, favorite(0), favorite(8001)] },
    };

    const result = await call('/user/playlist/updates', { token });

    expect(result.status).toBe(200);
    expect(result.body.checked).toBe(1);
    expect(recorded[1].rpcs[0].param).toEqual({ clientOrderDirs: [{ disstid: 8001, rtime: 0 }] });
  });

  it('drops answers for playlists that were not asked about', async () => {
    replies.CgiGetRecentSong = {
      data: { ...UPDATES, updateDirs: [updateDir(9999), updateDir(8002)] },
    };

    const result = await call('/user/playlist/updates', { token });

    expect(result.status).toBe(200);
    expect(result.body.playlists.map((item: { id: number }) => item.id)).toEqual([8002]);
  });

  it.each([
    ['an empty list', { ...UPDATES, updateDirs: [] }],
    ['null', { ...UPDATES, updateDirs: null }],
  ])('no update (%s) is a normal empty list', async (_label, data) => {
    replies.CgiGetRecentSong = { data };

    const result = await call('/user/playlist/updates', { token });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ code: 200, playlists: [], checked: 3, complete: true });
  });

  it.each([
    ['a non-list', { CgiGetRecentSong: { data: { ...UPDATES, updateDirs: {} } } }],
    [
      'nothing readable',
      { CgiGetRecentSong: { data: { ...UPDATES, updateDirs: [updateDir(0)] } } },
    ],
    [
      'a favorites list that is not a list',
      { CgiGetPlaylistFavInfo: { data: { ...FAVORITES, v_list: {} } } },
    ],
  ])('answers 502 for %s instead of an empty list', async (_label, override) => {
    Object.assign(replies, override);

    const result = await call('/user/playlist/updates', { token });

    expect(result.status).toBe(502);
    expect(result.body.errorKey).toBe('upstream.invalid-response');
  });

  it('a non-zero code inside the update data is an upstream failure', async () => {
    replies.CgiGetRecentSong = { data: { ...UPDATES, subcode: 2001, updateDirs: [] } };

    const result = await call('/user/playlist/updates', { token });

    expect(result.status).toBe(502);
    expect(result.body).toMatchObject({ errorKey: 'upstream.unknown', upstreamCode: 2001 });
  });

  it.each([
    'CgiGetPlaylistFavInfo',
    'CgiGetRecentSong',
  ])('a rejected credential on %s answers 401', async (method) => {
    replies[method] = { code: 1000 };

    const result = await call('/user/playlist/updates', { token });

    expect(result.status).toBe(401);
    expect(result.body).toMatchObject({ code: 401, errorKey: 'auth.credential-invalid' });
  });

  it('an unknown business code becomes 502 and keeps the number', async () => {
    replies.CgiGetRecentSong = { code: 1101 };

    const result = await call('/user/playlist/updates', { token });

    expect(result.status).toBe(502);
    expect(result.body).toMatchObject({ errorKey: 'upstream.unknown', upstreamCode: 1101 });
  });

  it('answers 502 without the error page when the upstream HTTP request fails', async () => {
    replies.CgiGetRecentSong = { httpStatus: 503 };

    const result = await call('/user/playlist/updates', { token });

    expect(result.status).toBe(502);
    expect(JSON.stringify(result.body)).not.toContain('fixture-private-error-page');
  });

  if (runtime === 'serverless') {
    it('needs the session secret like the other login routes', async () => {
      const result = await call('/user/playlist/updates', { token, env: {} });

      expect(result.status).toBe(501);
      expect(result.body.message).toContain('QQ_SESSION_SECRET is not set');
      expect(recorded).toEqual([]);
    });
  }
});
