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

// 歌曲流派（`TrackRelationServer.GetSongGenre`）：要登录。Node 与 serverless 跑同一份案例。
// 形状按 2026-11 带会话实测：`{ genres: [{ id, name, scheme, from_type, lp_url }], abt }`，
// 很多歌没有流派，正常回空数组。名称与 id 都是假数据。
// 流派和歌曲标签（`GetSongLabels`）、歌曲详情里的 `genre` 数字是三样东西，这里只管第一样。

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

const genre = (id: number, name: string) => ({
  id,
  name,
  scheme: '',
  from_type: 1,
  lp_url: 'https://y.qq.com/fixture-genre-landing-page',
});
const GENRES = { genres: [genre(901, 'Fixture Pop'), genre(902, 'Fixture Folk')], abt: '' };

describe.each(['node', 'serverless'] as const)('song genre route: %s', (runtime) => {
  let token: string;
  let recorded: Recorded[];
  let reply: Reply;
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
    reply = { data: GENRES };
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
        new Request(`https://song.invalid${path}`, { headers }),
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
    const result = await call('/song/genre?id=801');

    expect(result.status).toBe(401);
    expect(result.body).toMatchObject({ code: 401, errorKey: 'auth.required' });
    expect(result.headers['cache-control']).toBe('private, no-store');
    expect(recorded).toEqual([]);
  });

  it('treats a token that does not resolve as no session', async () => {
    const result = await call('/song/genre?id=801', { token: 'c'.repeat(64) });

    expect(result.status).toBe(401);
    expect(recorded).toEqual([]);
  });

  it.each([
    '/song/genre',
    '/song/genre?id=',
    '/song/genre?id=abc',
    '/song/genre?id=0',
    '/song/genre?id=1.5',
    '/song/genre?id=801&id=802',
  ])('%s answers 400 without reaching the upstream', async (path) => {
    const result = await call(path, { token });

    expect(result.status).toBe(400);
    expect(result.body.errorKey).toBe('input.invalid');
    expect(recorded).toEqual([]);
  });

  it('keeps only id and name, read once with the Android credential', async () => {
    const result = await call('/song/genre?id=801', { token });

    expect(result.status).toBe(200);
    expect(result.headers['cache-control']).toBe('private, no-store');
    expect(result.body).toEqual({
      code: 200,
      genres: [
        { id: 901, name: 'Fixture Pop' },
        { id: 902, name: 'Fixture Folk' },
      ],
    });
    expect(recorded).toHaveLength(1);
    expect(recorded[0].rpcs).toEqual([
      {
        module: 'music.recommend.TrackRelationServer',
        method: 'GetSongGenre',
        param: { songid: 801 },
      },
    ]);
    expect(recorded[0].comm).toMatchObject({
      ct: 11,
      authst: CONTRACT_CREDENTIAL.musickey,
      tmeLoginType: CONTRACT_CREDENTIAL.loginType,
    });
    expect(recorded[0].cookie).toContain(`qqmusic_key=${CONTRACT_CREDENTIAL.musickey}`);
    expect(JSON.stringify(result.body)).not.toContain('fixture-genre-landing-page');
  });

  it.each([
    ['an empty list', { genres: [], abt: '' }],
    ['null', { genres: null, abt: '' }],
    ['no genres key', { abt: '' }],
  ])('a song without a genre (%s) is a normal empty list', async (_label, data) => {
    reply = { data };

    const result = await call('/song/genre?id=801', { token });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ code: 200, genres: [] });
  });

  it('skips entries without a positive id or a name', async () => {
    reply = {
      data: {
        genres: [
          null,
          { id: 0, name: 'Fixture zero' },
          { id: '903', name: 'Fixture string id' },
          { id: 904, name: '' },
          { id: 905 },
          genre(906, 'Fixture Rock'),
        ],
      },
    };

    const result = await call('/song/genre?id=801', { token });

    expect(result.status).toBe(200);
    expect(result.body.genres).toEqual([{ id: 906, name: 'Fixture Rock' }]);
  });

  it.each([
    ['a non-list', { genres: {} }],
    ['nothing readable', { genres: [{ id: -1, name: 'x' }] }],
    ['a non-object payload', 'x'],
  ])('answers 502 for %s instead of an empty list', async (_label, data) => {
    reply = { data };

    const result = await call('/song/genre?id=801', { token });

    expect(result.status).toBe(502);
    expect(result.body.errorKey).toBe('upstream.invalid-response');
  });

  it('a rejected credential answers 401', async () => {
    reply = { code: 1000 };

    const result = await call('/song/genre?id=801', { token });

    expect(result.status).toBe(401);
    expect(result.body).toMatchObject({ code: 401, errorKey: 'auth.credential-invalid' });
  });

  it('an unknown business code becomes 502 and keeps the number', async () => {
    reply = { code: 1101 };

    const result = await call('/song/genre?id=801', { token });

    expect(result.status).toBe(502);
    expect(result.body).toMatchObject({ errorKey: 'upstream.unknown', upstreamCode: 1101 });
    expect(recorded).toHaveLength(1);
  });

  it('answers 502 without the error page when the upstream HTTP request fails', async () => {
    reply = { httpStatus: 503 };

    const result = await call('/song/genre?id=801', { token });

    expect(result.status).toBe(502);
    expect(JSON.stringify(result.body)).not.toContain('fixture-private-error-page');
  });

  if (runtime === 'serverless') {
    it('needs the session secret like the other login routes', async () => {
      const result = await call('/song/genre?id=801', { token, env: {} });

      expect(result.status).toBe(501);
      expect(result.body.message).toContain('QQ_SESSION_SECRET is not set');
      expect(recorded).toEqual([]);
    });
  }
});
