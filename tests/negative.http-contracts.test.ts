import type { AxiosRequestConfig } from 'axios';
import type { QrLoginService } from '../src/services/auth/qrLogin';
import type { createContractUpstream } from './helpers/contractUpstream';

let mockUpstream: ReturnType<typeof createContractUpstream>;
let mockNodeService: QrLoginService;
let mockFetch: typeof fetch;

// Both hosts use real controllers, services and adapters. Only outgoing HTTP is replaced.
jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  const create = actual.default.create.bind(actual.default);
  actual.default.create = (config: AxiosRequestConfig) =>
    create({
      ...config,
      adapter: async (outgoing: AxiosRequestConfig) => {
        const url = new URL(String(outgoing.url));
        for (const [key, value] of Object.entries(outgoing.params ?? {}))
          if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
        const response = await mockFetch(url, {
          method: String(outgoing.method ?? 'GET').toUpperCase(),
          body: outgoing.data === undefined ? undefined : String(outgoing.data),
        });
        return {
          data: await response.json(),
          status: response.status,
          statusText: 'OK',
          headers: {},
          config: outgoing,
        };
      },
    });
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
import { handleRequest } from '../src/serverless';
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
import { AUTH_ISOLATION_CODES, PLAYBACK_OBSERVATIONS } from './fixtures/protocol/negativeResponses';
import {
  CONTRACT_CREDENTIAL,
  CONTRACT_NOW,
  CONTRACT_PROFILE,
  CONTRACT_SECRET,
  createContractUpstream as makeUpstream,
} from './helpers/contractUpstream';

type Observation = (typeof PLAYBACK_OBSERVATIONS)[number];

describe.each(['node', 'serverless'] as const)('negative HTTP baselines: %s', (runtime) => {
  let token: string;
  let observation: Observation | undefined;
  let protocolFailure: { code: number; business?: number } | undefined;
  let rpcMethods: string[];
  let call: (
    path: string,
  ) => Promise<{ status: number; body: any; headers: Record<string, unknown> }>;

  beforeEach(async () => {
    jest.spyOn(Date, 'now').mockReturnValue(CONTRACT_NOW);
    for (const level of ['error', 'warn', 'debug'] as const)
      jest.spyOn(logger, level).mockImplementation(() => undefined);
    observation = undefined;
    protocolFailure = undefined;
    rpcMethods = [];
    mockUpstream = makeUpstream();
    mockFetch = async (input, init) => {
      const outgoing = new Request(input, init);
      const url = new URL(outgoing.url);
      if (url.hostname === 'u.y.qq.com' && url.pathname === '/cgi-bin/musicu.fcg') {
        const payload = JSON.parse(url.searchParams.get('data') ?? (await outgoing.clone().text()));
        const descriptor = payload.req_0 ?? payload.songinfo;
        if (descriptor) {
          rpcMethods.push(descriptor.method);
          if (protocolFailure && descriptor.method === 'GetLoginUserInfo')
            return Response.json({
              code: protocolFailure.code,
              req_0: {
                ...(protocolFailure.business === undefined
                  ? {}
                  : { code: protocolFailure.business }),
                data: {},
              },
            });
          // Reuse entry facts, not the GetEVkey request protocol: the API still calls UrlGetVkey.
          if (observation && descriptor.method === 'UrlGetVkey')
            return Response.json(observation.response);
          if (observation?.song && descriptor.method === 'get_song_detail_yqq')
            return Response.json({
              code: 0,
              songinfo: { code: 0, data: { track_info: observation.song } },
            });
        }
      }
      return mockUpstream.fetch(input, init);
    };
    jest.spyOn(global, 'fetch').mockImplementation(mockFetch);
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
    setLegacyHttpTransport(createAxiosLegacyTransport());
    app.silent = true;
    call = async (path) => {
      if (runtime === 'node') {
        const result = await request(app.callback()).get(path).set('X-QQ-Session', token);
        return { status: result.status, body: result.body, headers: result.headers };
      }
      const result = await handleRequest(
        new Request(`https://contract.invalid${path}`, { headers: { 'X-QQ-Session': token } }),
        { QQ_SESSION_SECRET: CONTRACT_SECRET },
        { qqRelay: mockUpstream.relay },
      );
      return {
        status: result.status,
        body: await result.json(),
        headers: Object.fromEntries(result.headers),
      };
    };
  });

  afterEach(async () => {
    await mockNodeService.logout();
    jest.restoreAllMocks();
  });

  it.each(
    PLAYBACK_OBSERVATIONS,
  )('keeps per-song playback and session semantics for $name', async (fixture) => {
    observation = fixture;
    if (fixture.song) {
      const metadata = await call(`/getSongInfo/${fixture.song.mid}`);
      expect(metadata.status).toBe(200);
      expect(metadata.body).toEqual({
        response: { code: 0, songinfo: { code: 0, data: { track_info: fixture.song } } },
      });
    }
    const entries = fixture.response.req_0.data.midurlinfo;
    const result = await call(
      `/getMusicPlay/${entries.map((item) => item.songmid).join(',')}?quality=m4a`,
    );
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      data: {
        playUrl: Object.fromEntries(
          entries.map((item) => [
            item.songmid,
            item.purl
              ? {
                  url: `https://stream.invalid/${item.purl}`,
                  error: false,
                  source: {
                    kind: item.result === 0 ? 'full' : 'unknown',
                    protocol: 'android-vkey',
                    cdn: 'response-sip',
                  },
                }
              : {
                  url: '',
                  error: '暂无播放链接',
                  restriction: expect.objectContaining({
                    key: 'url_unavailable',
                    evidence: 'observed-response',
                  }),
                  source: { kind: 'full', protocol: 'android-vkey', cdn: 'none' },
                },
          ]),
        ),
      },
    });
    expect(result.headers).not.toHaveProperty('retry-after');
    // 拿不到链接、原因没确认的歌会用同一会话再取一次：整批最多多一个请求，再取仍失败时回应不变、会话照旧。
    const unavailable = entries.filter((item) => !item.purl).length;
    expect(rpcMethods.filter((method) => method === 'UrlGetVkey')).toHaveLength(
      unavailable ? 2 : 1,
    );
    const status = await call('/login/status');
    expect(status.status).toBe(200);
    expect(status.body).toEqual({ code: 200, data: { profile: CONTRACT_PROFILE } });
  });

  it.each(
    AUTH_ISOLATION_CODES,
  )('keeps catalog business %i isolated from session invalidation', async (code) => {
    mockUpstream.state.catalogCode = code;
    const result = await call('/getSingerAlbum?singermid=fixture-artist');
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ response: { code: 0, singer: { code, data: {} } } });
    expect(result.headers).not.toHaveProperty('retry-after');
    const status = await call('/login/status');
    expect(status.status).toBe(200);
    expect(status.body).toEqual({ code: 200, data: { profile: CONTRACT_PROFILE } });
  });

  it.each([
    {
      name: 'business refusal',
      code: 0,
      business: 2000,
      expected: 'get-login-user failed (HTTP 200, global=0, code=2000)',
    },
    {
      name: 'gateway refusal',
      code: 500003,
      business: 0,
      expected: 'get-login-user failed (HTTP 200, global=500003, code=0)',
    },
    {
      name: 'unknown business code',
      code: 0,
      business: 987654,
      expected: 'get-login-user failed (HTTP 200, global=0, code=987654)',
    },
    {
      name: 'negative business code',
      code: 0,
      business: -777,
      expected: 'get-login-user failed (HTTP 200, global=0, code=-777)',
    },
    {
      name: 'missing business code',
      code: 500003,
      expected: 'get-login-user failed (HTTP 200, global=500003, code=unknown)',
    },
  ])('keeps the precise legacy 500 text for $name', async ({ code, business, expected }) => {
    protocolFailure = { code, business };
    const result = await call('/user/detail');
    expect(result.status).toBe(500);
    expect(result.body).toEqual({ error: expected });
    expect(result.body.error).toMatch(
      /\bfailed \(HTTP 2\d\d, global=(-?\d+), code=(-?\d+|unknown)\)/,
    );
    expect(result.headers).not.toHaveProperty('retry-after');
    expect(rpcMethods).toEqual(['GetLoginUserInfo']);
  });
});
