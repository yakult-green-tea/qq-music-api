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

// 播完自动接歌（`AutoPlayServer.GetAutoPlayList`）：要登录。Node 与 serverless 跑同一份案例。
// 形状按 2026-11 带会话实测：`{ retcode, msg, vecSong: [{ track }] }`，种子 1 首、amount 5 时两个账号都回 50 首。
// 和 `/song/similar`（`TrackRelationServer.GetSimilarSongs`）是两支不同的上游。名称与 id 都是假数据。

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

const track = (id: number) => ({
  id,
  mid: `fixture-autoplay-${id}`,
  name: `Fixture autoplay song ${id}`,
  file: { media_mid: `fixture-media-${id}` },
});
const row = (value: unknown) => ({ track: value });
const tracks = (count: number) => Array.from({ length: count }, (_, index) => track(9001 + index));
const AUTOPLAY = { retcode: 0, msg: '', vecSong: tracks(50).map(row) };

describe.each(['node', 'serverless'] as const)('autoplay route: %s', (runtime) => {
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
    reply = { data: AUTOPLAY };
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
        new Request(`https://autoplay.invalid${path}`, { headers }),
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
    const result = await call('/recommend/autoplay?songids=801');

    expect(result.status).toBe(401);
    expect(result.body).toMatchObject({ code: 401, errorKey: 'auth.required' });
    expect(result.headers['cache-control']).toBe('private, no-store');
    expect(recorded).toEqual([]);
  });

  it('treats a token that does not resolve as no session', async () => {
    const result = await call('/recommend/autoplay?songids=801', { token: 'c'.repeat(64) });

    expect(result.status).toBe(401);
    expect(recorded).toEqual([]);
  });

  it.each([
    '/recommend/autoplay',
    '/recommend/autoplay?songids=',
    '/recommend/autoplay?songids=abc',
    '/recommend/autoplay?songids=0',
    '/recommend/autoplay?songids=801,',
    '/recommend/autoplay?songids=801,801',
    '/recommend/autoplay?songids=1,2,3,4,5,6',
    '/recommend/autoplay?songids=801&songids=802',
    '/recommend/autoplay?songids=801&limit=0',
    '/recommend/autoplay?songids=801&limit=51',
    '/recommend/autoplay?songids=801&limit=1.5',
    '/recommend/autoplay?songids=801&limit=05',
    '/recommend/autoplay?songids=801&limit=',
  ])('%s answers 400 without reaching the upstream', async (path) => {
    const result = await call(path, { token });

    expect(result.status).toBe(400);
    expect(result.body.errorKey).toBe('input.invalid');
    expect(recorded).toEqual([]);
  });

  it('returns every track the upstream gives, in order, read once with the Android credential', async () => {
    const result = await call('/recommend/autoplay?songids=801,802', { token });

    expect(result.status).toBe(200);
    expect(result.headers['cache-control']).toBe('private, no-store');
    expect(result.body).toEqual({ code: 200, songs: tracks(50) });
    expect(recorded).toHaveLength(1);
    expect(recorded[0].rpcs).toEqual([
      {
        module: 'music.recommend.AutoPlayServer',
        method: 'GetAutoPlayList',
        param: { vecSong: [801, 802], amount: 2, from: 8 },
      },
    ]);
    expect(recorded[0].comm).toMatchObject({
      ct: 11,
      authst: CONTRACT_CREDENTIAL.musickey,
      tmeLoginType: CONTRACT_CREDENTIAL.loginType,
    });
    expect(recorded[0].cookie).toContain(`qqmusic_key=${CONTRACT_CREDENTIAL.musickey}`);
  });

  it('limit only trims the answer locally and keeps the upstream request and order', async () => {
    const result = await call('/recommend/autoplay?songids=801&limit=3', { token });

    expect(result.status).toBe(200);
    expect(result.body.songs).toEqual(tracks(3));
    expect(recorded[0].rpcs[0].param).toEqual({ vecSong: [801], amount: 1, from: 8 });
  });

  it('skips rows without a playable track', async () => {
    reply = {
      data: { retcode: 0, vecSong: [row(null), row({ id: 9100, mid: '' }), 'x', row(track(9101))] },
    };

    const result = await call('/recommend/autoplay?songids=801', { token });

    expect(result.status).toBe(200);
    expect(result.body.songs).toEqual([track(9101)]);
  });

  it.each([
    ['an empty list', { retcode: 0, vecSong: [] }],
    ['null', { retcode: 0, vecSong: null }],
    ['no vecSong key', { retcode: 0 }],
  ])('no recommendation (%s) is a normal empty list', async (_label, data) => {
    reply = { data };

    const result = await call('/recommend/autoplay?songids=801', { token });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ code: 200, songs: [] });
  });

  it.each([
    ['a non-list', { retcode: 0, vecSong: {} }],
    ['nothing readable', { retcode: 0, vecSong: [row(null)] }],
    ['a non-object payload', 'x'],
  ])('answers 502 for %s instead of an empty list', async (_label, data) => {
    reply = { data };

    const result = await call('/recommend/autoplay?songids=801', { token });

    expect(result.status).toBe(502);
    expect(result.body.errorKey).toBe('upstream.invalid-response');
  });

  it('a non-zero retcode inside the data is an upstream failure, not an empty list', async () => {
    reply = { data: { retcode: 2001, msg: 'fixture', vecSong: [] } };

    const result = await call('/recommend/autoplay?songids=801', { token });

    expect(result.status).toBe(502);
    expect(result.body).toMatchObject({ errorKey: 'upstream.unknown', upstreamCode: 2001 });
  });

  it('a rejected credential answers 401', async () => {
    reply = { code: 1000 };

    const result = await call('/recommend/autoplay?songids=801', { token });

    expect(result.status).toBe(401);
    expect(result.body).toMatchObject({ code: 401, errorKey: 'auth.credential-invalid' });
  });

  it('an unknown business code becomes 502 and keeps the number', async () => {
    reply = { code: 1101 };

    const result = await call('/recommend/autoplay?songids=801', { token });

    expect(result.status).toBe(502);
    expect(result.body).toMatchObject({ errorKey: 'upstream.unknown', upstreamCode: 1101 });
  });

  it('answers 502 without the error page when the upstream HTTP request fails', async () => {
    reply = { httpStatus: 503 };

    const result = await call('/recommend/autoplay?songids=801', { token });

    expect(result.status).toBe(502);
    expect(JSON.stringify(result.body)).not.toContain('fixture-private-error-page');
  });

  if (runtime === 'serverless') {
    it('needs the session secret like the other login routes', async () => {
      const result = await call('/recommend/autoplay?songids=801', { token, env: {} });

      expect(result.status).toBe(501);
      expect(result.body.message).toContain('QQ_SESSION_SECRET is not set');
      expect(recorded).toEqual([]);
    });
  }
});
