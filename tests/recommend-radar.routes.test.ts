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

// 刷歌模式（雷达）：有会话就带凭证，没有就匿名。Node 与 serverless 跑同一份案例，只替换对外的 fetch。
// 结构按 2026-10 实测整理（`GetRadarSong { Page, ReqType, FavSongs, EntranceSongs }` → `VecSongs[].Track`），
// 歌名与 id 都是假数据。

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
  body: Record<string, any>;
}

const track = (id: number) => ({
  id,
  mid: `fixture-radar-${id}`,
  name: `Fixture radar song ${id}`,
  file: { media_mid: `fixture-media-${id}` },
});
const entry = (value: unknown) => ({
  Track: value,
  Trace: '',
  Tj: '',
  Abt: '',
  Ext: {},
  RadioRecTag: { RecReasonTemplate: '', RecReasons: [], RecType: 0 },
});
const RADAR = {
  VecSongs: [entry(track(701)), entry(track(702))],
  RecommendSongIds: [701, 702],
  BaseSongIds: [],
  HasMore: true,
  TimeStamp: 0,
  Toast: '',
  Ext: {},
};

describe.each(['node', 'serverless'] as const)('radar route: %s', (runtime) => {
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
    replies = { GetRadarSong: { data: RADAR } };
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
        return { status: result.status, body: result.body };
      }
      const result = await handleRequest(
        new Request(`https://recommend.invalid${path}`, { headers }),
        options.env ?? { QQ_SESSION_SECRET: CONTRACT_SECRET },
      );
      return { status: result.status, body: (await result.json()) as HttpResult['body'] };
    };
  });

  afterEach(async () => {
    await mockNodeService.logout();
    jest.restoreAllMocks();
  });

  it('reads anonymously without a session, with the web comm and no cookie', async () => {
    const result = await call('/recommend/radar');

    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      code: 200,
      page: 1,
      songs: [track(701), track(702)],
      more: true,
    });
    expect(recorded).toHaveLength(1);
    expect(recorded[0].rpcs).toEqual([
      {
        module: 'music.recommend.TrackRelationServer',
        method: 'GetRadarSong',
        param: { Page: 1, ReqType: 0, FavSongs: [], EntranceSongs: [] },
      },
    ]);
    expect(recorded[0].comm).toEqual({ ct: 24, cv: 0 });
    expect(recorded[0].cookie).toBeNull();
  });

  it('uses the credential when the session resolves', async () => {
    const result = await call('/recommend/radar', { token });

    expect(result.status).toBe(200);
    expect(recorded[0].comm).toMatchObject({
      ct: 11,
      authst: CONTRACT_CREDENTIAL.musickey,
      tmeLoginType: CONTRACT_CREDENTIAL.loginType,
    });
    expect(recorded[0].cookie).toContain(`qqmusic_key=${CONTRACT_CREDENTIAL.musickey}`);
  });

  it('falls back to anonymous when the token does not resolve', async () => {
    const result = await call('/recommend/radar', { token: 'c'.repeat(64) });

    expect(result.status).toBe(200);
    expect(recorded[0].comm).toEqual({ ct: 24, cv: 0 });
    expect(recorded[0].cookie).toBeNull();
  });

  it.each([
    ['2', 2],
    ['100', 100],
    ['101', 100],
    ['0', 1],
    ['-3', 1],
    ['abc', 1],
  ])('reads page=%s as Page %d', async (page, expected) => {
    const result = await call(`/recommend/radar?page=${page}`);

    expect(recorded[0].rpcs[0].param).toEqual({
      Page: expected,
      ReqType: 0,
      FavSongs: [],
      EntranceSongs: [],
    });
    expect(result.body.page).toBe(expected);
  });

  it('reports no more when the upstream does not say there is more', async () => {
    replies.GetRadarSong = { data: { ...RADAR, HasMore: 'yes' } };

    const result = await call('/recommend/radar');

    expect(result.body.more).toBe(false);
  });

  it('skips entries without a playable track', async () => {
    replies.GetRadarSong = {
      data: {
        ...RADAR,
        VecSongs: [entry(null), entry({ id: 703, mid: '' }), entry(track(704)), null],
      },
    };

    const result = await call('/recommend/radar');

    expect(result.status).toBe(200);
    expect(result.body.songs).toEqual([track(704)]);
  });

  it.each([
    ['no songs', { ...RADAR, VecSongs: [] }, 422, 'resource.not-found'],
    ['a non-list', { ...RADAR, VecSongs: {} }, 502, 'upstream.invalid-response'],
    ['no readable song', { ...RADAR, VecSongs: [entry(null)] }, 502, 'upstream.invalid-response'],
  ])('answers for %s', async (_label, data, status, errorKey) => {
    replies.GetRadarSong = { data };

    const result = await call('/recommend/radar');

    expect(result.status).toBe(status);
    expect(result.body.errorKey).toBe(errorKey);
  });

  it('answers 401 when a resolved credential is rejected', async () => {
    replies.GetRadarSong = { code: 1000 };

    const result = await call('/recommend/radar', { token });

    expect(result.status).toBe(401);
    expect(result.body).toMatchObject({ code: 401, errorKey: 'auth.credential-invalid' });
  });

  it('an unknown business code becomes 502 and keeps the number', async () => {
    replies.GetRadarSong = { code: 1101 };

    const result = await call('/recommend/radar');

    expect(result.status).toBe(502);
    expect(result.body).toMatchObject({ errorKey: 'upstream.unknown', upstreamCode: 1101 });
  });

  it('answers 502 without the error page when the upstream HTTP request fails', async () => {
    replies.GetRadarSong = { httpStatus: 503 };

    const result = await call('/recommend/radar');

    expect(result.status).toBe(502);
    expect(JSON.stringify(result.body)).not.toContain('fixture-private-error-page');
  });

  describe('private personal FM', () => {
    it.each([undefined, 'invalid-token'])('requires a resolving session: %s', async (value) => {
      const result = await call('/user/personal-fm', { token: value });
      expect(result.status).toBe(401);
      expect(result.body.errorKey).toBe('auth.required');
      expect(recorded).toHaveLength(0);
    });

    it.each([undefined, '1', '2', '3'])('reads an explicit personal FM page: %s', async (page) => {
      const result = await call(`/user/personal-fm${page ? `?page=${page}` : ''}`, { token });
      const expected = Number(page ?? 1);
      expect(result.status).toBe(200);
      expect(result.body).toEqual({
        code: 200,
        station: 'personal-fm',
        page: expected,
        songs: [track(701), track(702)],
        more: true,
        nextPage: expected + 1,
      });
      expect(recorded).toHaveLength(1);
      expect(recorded[0].rpcs[0]).toMatchObject({
        method: 'GetRadarSong',
        param: { Page: expected, ReqType: 0, FavSongs: [], EntranceSongs: [] },
      });
      expect(recorded[0].comm.authst).toBe(CONTRACT_CREDENTIAL.musickey);
    });

    it.each([
      '0',
      '-1',
      '101',
      '1x',
      '1.5',
      '',
      '01',
    ])('rejects invalid pages without calling upstream: %s', async (page) => {
      const result = await call(`/user/personal-fm?page=${page}`, { token });
      expect(result.status).toBe(400);
      expect(result.body.errorKey).toBe('input.invalid');
      expect(recorded).toHaveLength(0);
    });

    it('does not silently repeat page 100 when the local bound is reached', async () => {
      const result = await call('/user/personal-fm?page=100', { token });
      expect(result.body).toMatchObject({ page: 100, more: true, paginationLimitReached: true });
      expect(result.body).not.toHaveProperty('nextPage');
    });

    it('does not invent another page after the upstream ends the stream', async () => {
      replies.GetRadarSong = { data: { ...RADAR, HasMore: false } };
      const result = await call('/user/personal-fm?page=2', { token });
      expect(result.status).toBe(200);
      expect(result.body.more).toBe(false);
      expect(result.body).not.toHaveProperty('nextPage');
    });

    it('does not retry a failed batch which might already have been consumed', async () => {
      replies.GetRadarSong = { httpStatus: 503 };
      const result = await call('/user/personal-fm', { token });
      expect(result.status).toBe(502);
      expect(recorded).toHaveLength(1);
    });

    it('keeps gateway and credential conflicts at 502', async () => {
      replies.GetRadarSong = { globalCode: 500003, code: 1000 };
      const result = await call('/user/personal-fm', { token });
      expect(result.status).toBe(502);
      expect(result.body.kind).not.toBe('credential-invalid');
    });

    it('keeps empty batches distinct from unreadable entries', async () => {
      replies.GetRadarSong = { data: { ...RADAR, VecSongs: [] } };
      expect((await call('/user/personal-fm', { token })).status).toBe(422);
      replies.GetRadarSong = { data: { ...RADAR, VecSongs: [entry(null)] } };
      expect((await call('/user/personal-fm', { token })).status).toBe(502);
    });
  });

  if (runtime === 'serverless') {
    it('still serves the anonymous radar without a session secret', async () => {
      const result = await call('/recommend/radar', { token, env: {} });

      expect(result.status).toBe(200);
      expect(recorded[0].comm).toEqual({ ct: 24, cv: 0 });
      expect(recorded[0].cookie).toBeNull();
    });
  }
});
