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

// 收藏的 MV（`MVFavRead.getMyFavMV`）：要登录。Node 与 serverless 跑同一份案例。
// 形状按 2026-11 带会话实测：`{ code, subcode, msg, hasmore, total, mvlist: [...] }`。官方 App 用这一版、
// 没有分页参数；`getMyFavMV_v2` 同一个账号少回一笔（3 对 2），所以不用 v2，下面有一例固定这个选择。
// 名称与 id 都是假数据。

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

const upstreamMv = (n: number, overrides: Record<string, unknown> = {}) => ({
  mid: `fixtureMvMid${n}`,
  type: 0,
  id: 7000 + n,
  time: 1790000000 + n,
  status: 0,
  vid: `fixturevid${n}`,
  mv_name: `Fixture MV ${n}`,
  singer_mid: `fixtureSinger${n}`,
  singer_id: 600 + n,
  singer_name: `Fixture singer ${n}`,
  uploader_encuin: 'fixture-private-uploader',
  uploader_nick: 'fixture-private-nick',
  mv_picurl: `https://y.gtimg.cn/fixture-mv-${n}.jpg`,
  publish_date: 1700000000 + n,
  playcount: 1000 + n,
  singer: [{ id: 600 + n, mid: `fixtureSinger${n}`, name: `Fixture singer ${n}` }],
  duration: 200 + n,
  icon_type: 0,
  smallIcons: [{ width: 1, height: 1, pic: 'https://y.gtimg.cn/fixture-icon.png' }],
  ...overrides,
});
const answeredMv = (n: number) => ({
  vid: `fixturevid${n}`,
  mid: `fixtureMvMid${n}`,
  name: `Fixture MV ${n}`,
  cover: `https://y.gtimg.cn/fixture-mv-${n}.jpg`,
  duration: 200 + n,
  playCount: 1000 + n,
  publishDate: 1700000000 + n,
  time: 1790000000 + n,
  singers: [{ id: 600 + n, mid: `fixtureSinger${n}`, name: `Fixture singer ${n}` }],
});
const FAVORITES = {
  code: 0,
  subcode: 0,
  msg: '',
  hasmore: 0,
  total: 3,
  mvlist: [upstreamMv(1), upstreamMv(2), upstreamMv(3)],
};

describe.each(['node', 'serverless'] as const)('favorite MV route: %s', (runtime) => {
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
    reply = { data: FAVORITES };
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
        new Request(`https://mvs.invalid${path}`, { headers }),
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
    const result = await call('/user/mvs');

    expect(result.status).toBe(401);
    expect(result.body).toMatchObject({ code: 401, errorKey: 'auth.required' });
    expect(result.headers['cache-control']).toBe('private, no-store');
    expect(recorded).toEqual([]);
  });

  it('treats a token that does not resolve as no session', async () => {
    const result = await call('/user/mvs', { token: 'c'.repeat(64) });

    expect(result.status).toBe(401);
    expect(recorded).toEqual([]);
  });

  it.each([
    '/user/mvs?page=2',
    '/user/mvs?page=0',
    '/user/mvs?page=',
    '/user/mvs?page=1&page=1',
  ])('%s answers 400: only the first page exists', async (path) => {
    const result = await call(path, { token });

    expect(result.status).toBe(400);
    expect(result.body.errorKey).toBe('input.invalid');
    expect(recorded).toEqual([]);
  });

  it('reads the official list once with the Android credential and keeps only the public fields', async () => {
    const result = await call('/user/mvs?page=1', { token });

    expect(result.status).toBe(200);
    expect(result.headers['cache-control']).toBe('private, no-store');
    expect(result.body).toEqual({
      code: 200,
      mvs: [answeredMv(1), answeredMv(2), answeredMv(3)],
      total: 3,
      more: false,
    });
    expect(recorded).toHaveLength(1);
    expect(recorded[0].rpcs).toEqual([
      {
        module: 'music.musicasset.MVFavRead',
        method: 'getMyFavMV',
        param: { uin: CONTRACT_CREDENTIAL.encryptUin, req_icon_type: 1, support: 1 },
      },
    ]);
    expect(recorded[0].comm).toMatchObject({ ct: 11, authst: CONTRACT_CREDENTIAL.musickey });
    const text = JSON.stringify(result.body);
    expect(text).not.toContain('fixture-private-uploader');
    expect(text).not.toContain('fixture-private-nick');
  });

  it('uses the official v1 call, not getMyFavMV_v2 (v2 answered one fewer item on a real account)', async () => {
    await call('/user/mvs', { token });

    expect(recorded.flatMap((item) => item.rpcs.map((rpc) => rpc.method))).toEqual(['getMyFavMV']);
  });

  it('passes the upstream hasmore through as more without offering a next page', async () => {
    reply = { data: { ...FAVORITES, hasmore: 1, total: 40 } };

    const result = await call('/user/mvs', { token });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ total: 40, more: true });
    expect(result.body).not.toHaveProperty('nextPage');
  });

  it('skips entries without a vid and leaves out unreadable fields', async () => {
    reply = {
      data: {
        ...FAVORITES,
        mvlist: [
          null,
          upstreamMv(4, { vid: '' }),
          upstreamMv(5, {
            mid: 5,
            mv_name: null,
            mv_picurl: 7,
            duration: -1,
            playcount: '12万',
            publish_date: 1.5,
            time: 'x',
            singer: [null, { id: 0, mid: 'x', name: 'x' }, { id: 605, mid: '', name: 'Fixture' }],
          }),
        ],
      },
    };

    const result = await call('/user/mvs', { token });

    expect(result.status).toBe(200);
    expect(result.body.mvs).toEqual([
      {
        vid: 'fixturevid5',
        mid: '',
        name: '',
        cover: '',
        singers: [{ id: 605, mid: '', name: 'Fixture' }],
      },
    ]);
  });

  it.each([
    ['an empty list', { ...FAVORITES, total: 0, mvlist: [] }],
    ['null', { ...FAVORITES, total: 0, mvlist: null }],
  ])('no favorite MV (%s) is a normal empty list', async (_label, data) => {
    reply = { data };

    const result = await call('/user/mvs', { token });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ code: 200, mvs: [], total: 0, more: false });
  });

  it('answers null for a missing or bad total instead of guessing', async () => {
    reply = { data: { ...FAVORITES, total: '3' } };

    const result = await call('/user/mvs', { token });

    expect(result.status).toBe(200);
    expect(result.body.total).toBeNull();
  });

  it.each([
    ['a non-list', { ...FAVORITES, mvlist: {} }],
    ['nothing readable', { ...FAVORITES, mvlist: [upstreamMv(6, { vid: null })] }],
    ['a non-object payload', 'x'],
  ])('answers 502 for %s instead of an empty list', async (_label, data) => {
    reply = { data };

    const result = await call('/user/mvs', { token });

    expect(result.status).toBe(502);
    expect(result.body.errorKey).toBe('upstream.invalid-response');
  });

  it('a non-zero code inside the data is an upstream failure, not an empty list', async () => {
    reply = { data: { ...FAVORITES, code: 2001, mvlist: [] } };

    const result = await call('/user/mvs', { token });

    expect(result.status).toBe(502);
    expect(result.body).toMatchObject({ errorKey: 'upstream.unknown', upstreamCode: 2001 });
  });

  it('a rejected credential answers 401', async () => {
    reply = { code: 1000 };

    const result = await call('/user/mvs', { token });

    expect(result.status).toBe(401);
    expect(result.body).toMatchObject({ code: 401, errorKey: 'auth.credential-invalid' });
  });

  it('an unknown business code becomes 502 and keeps the number', async () => {
    reply = { code: 1101 };

    const result = await call('/user/mvs', { token });

    expect(result.status).toBe(502);
    expect(result.body).toMatchObject({ errorKey: 'upstream.unknown', upstreamCode: 1101 });
  });

  it('answers 502 without the error page when the upstream HTTP request fails', async () => {
    reply = { httpStatus: 503 };

    const result = await call('/user/mvs', { token });

    expect(result.status).toBe(502);
    expect(JSON.stringify(result.body)).not.toContain('fixture-private-error-page');
  });

  if (runtime === 'serverless') {
    it('needs the session secret like the other login routes', async () => {
      const result = await call('/user/mvs', { token, env: {} });

      expect(result.status).toBe(501);
      expect(result.body.message).toContain('QQ_SESSION_SECRET is not set');
      expect(recorded).toEqual([]);
    });
  }
});
