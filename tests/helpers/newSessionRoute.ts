import type { QrLoginService } from '../../src/services/auth/qrLogin';

let mockNodeService: QrLoginService;

// 要在 src/app 之前 import：Node 的登录服务换成测试里建的那一个，其余照真实路径运行。
jest.mock('../../src/services/auth/qrLogin.node', () => ({
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
import app from '../../src/app';
import { handleRequest, type ServerlessEnv } from '../../src/serverless';
import { deriveAndroidDevice } from '../../src/serverless/derivedDevice';
import { createSealedSessionResolver } from '../../src/serverless/sealedResolver';
import { createMemoryDeviceContextRepository } from '../../src/services/auth/deviceContext';
import createAuthHttpClient from '../../src/services/auth/httpClient';
import {
  createMemoryAuthSessionRepository,
  createQrLoginService,
} from '../../src/services/auth/qrLogin';
import { logger } from '../../src/util/logger';
import deviceFixture from '../fixtures/contracts/device-v1.json';
import { CONTRACT_CREDENTIAL, CONTRACT_NOW, CONTRACT_SECRET } from './contractUpstream';

// 3.3.8 起新的带会话路由共用的测试架子：两个宿主跑同一份案例，上游 musicu 按 method 回假资料。
// 名称与 id 都用假数据；回应里出现 `fixture-private` 字样的值都不该被交出。

export interface Rpc {
  module: string;
  method: string;
  param: Record<string, unknown>;
}
export interface Recorded {
  comm: Record<string, unknown>;
  cookie: string | null;
  rpcs: Rpc[];
}
export interface Reply {
  httpStatus?: number;
  globalCode?: number;
  code?: number;
  data?: unknown;
}
export interface HttpResult {
  status: number;
  headers: Record<string, string | undefined>;
  body: Record<string, any>;
}
export type Runtime = 'node' | 'serverless';
export interface CallOptions {
  token?: string;
  env?: ServerlessEnv;
  method?: 'GET' | 'POST';
  body?: unknown;
}
export interface SessionRouteContext {
  recorded: Recorded[];
  replies: Record<string, Reply>;
  token: string;
  call: (path: string, options?: CallOptions) => Promise<HttpResult>;
}

export { CONTRACT_CREDENTIAL };

export const setupSessionRoute = (
  runtime: Runtime,
  defaults: () => Record<string, Reply>,
): SessionRouteContext => {
  const ctx = { recorded: [], replies: {}, token: '' } as unknown as SessionRouteContext;

  const upstream = async (input: string | URL | Request, init?: RequestInit) => {
    const fetched = new Request(input, init);
    const url = new URL(fetched.url);
    if (url.hostname !== 'u.y.qq.com' || url.pathname !== '/cgi-bin/musicu.fcg')
      throw new Error(`Unstubbed request: ${url.origin}${url.pathname}`);
    const payload = JSON.parse(await fetched.text());
    const rpcs: Rpc[] = Object.entries(payload)
      .filter(([key]) => key.startsWith('req_'))
      .map(([, value]) => value as Rpc);
    ctx.recorded.push({ comm: payload.comm, cookie: fetched.headers.get('cookie'), rpcs });
    const reply = ctx.replies[rpcs[0]?.method] ?? {};
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
    ctx.recorded = [];
    ctx.replies = defaults();
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
    ctx.token =
      runtime === 'node'
        ? session.token
        : await createSealedSessionResolver({ secrets: { current: CONTRACT_SECRET } }).issue(
            session,
          );
    app.silent = true;
  });

  afterEach(async () => {
    await mockNodeService.logout();
    jest.restoreAllMocks();
  });

  ctx.call = async (path, options = {}) => {
    const method = options.method ?? 'GET';
    const headers: Record<string, string> = {};
    if (options.token) headers['X-QQ-Session'] = options.token;
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (runtime === 'node') {
      const agent = request(app.callback());
      const pending = method === 'GET' ? agent.get(path) : agent.post(path);
      const result = await pending.set(headers).send(body);
      return { status: result.status, headers: result.headers, body: result.body };
    }
    const result = await handleRequest(
      new Request(`https://new-route.invalid${path}`, { method, headers, body }),
      options.env ?? { QQ_SESSION_SECRET: CONTRACT_SECRET },
    );
    return {
      status: result.status,
      headers: Object.fromEntries(result.headers.entries()),
      body: (await result.json()) as HttpResult['body'],
    };
  };

  return ctx;
};

/**
 * 每条带会话的只读路由都要过的一组案例：没会话 401 且不打上游、带 private no-store；解不开的会话当没会话；
 * 上游拒绝凭证 401；未知业务码 502 并保留数字；HTTP 失败 502 且不漏错误页；Serverless 没密钥 501。
 * `method` 是要被弄坏的那一支上游方法。
 */
export const sharedSessionReadCases = (
  runtime: Runtime,
  ctx: SessionRouteContext,
  path: string,
  method: string,
): void => {
  it('answers 401 without a session, never reaches the upstream and is not cached', async () => {
    const result = await ctx.call(path);

    expect(result.status).toBe(401);
    expect(result.body).toMatchObject({ code: 401, errorKey: 'auth.required' });
    expect(result.headers['cache-control']).toBe('private, no-store');
    expect(ctx.recorded).toEqual([]);
  });

  it('treats a token that does not resolve as no session', async () => {
    const result = await ctx.call(path, { token: 'c'.repeat(64) });

    expect(result.status).toBe(401);
    expect(ctx.recorded).toEqual([]);
  });

  it(`a rejected credential on ${method} answers 401`, async () => {
    ctx.replies[method] = { code: 1000 };

    const result = await ctx.call(path, { token: ctx.token });

    expect(result.status).toBe(401);
    expect(result.body).toMatchObject({ code: 401, errorKey: 'auth.credential-invalid' });
  });

  it(`an unknown business code on ${method} becomes 502 and keeps the number`, async () => {
    ctx.replies[method] = { code: 1101 };

    const result = await ctx.call(path, { token: ctx.token });

    expect(result.status).toBe(502);
    expect(result.body).toMatchObject({ errorKey: 'upstream.unknown', upstreamCode: 1101 });
  });

  it(`answers 502 without the error page when ${method} fails over HTTP`, async () => {
    ctx.replies[method] = { httpStatus: 503 };

    const result = await ctx.call(path, { token: ctx.token });

    expect(result.status).toBe(502);
    expect(JSON.stringify(result.body)).not.toContain('fixture-private-error-page');
  });

  if (runtime === 'serverless')
    it('needs the session secret like the other login routes', async () => {
      const result = await ctx.call(path, { token: ctx.token, env: {} });

      expect(result.status).toBe(501);
      expect(result.body.message).toContain('QQ_SESSION_SECRET is not set');
      expect(ctx.recorded).toEqual([]);
    });
};
