import { serverlessPathOf, sharedRoutes } from '../routes/manifest';
import { loginChannels } from '../routes/operations/loginChannels';
import { protectAccountWrite, refusedAccountWrite } from '../routes/operations/writeSafety';
import { AUTH_HEADER_NAME, tokenFromCookieString } from '../routes/sessionToken';
import { createMemoryDeviceContextRepository } from '../services/auth/deviceContextStore';
import {
  createQrLoginService,
  type QqQrRelay,
  type QrLoginService,
} from '../services/auth/qrLogin';
import { setLegacyHttpTransport } from '../services/httpTransport';
import { createFetchAuthHttpClient } from '../transport/fetchAuthHttpClient';
import { createFetchLegacyTransport } from '../transport/fetchLegacyTransport';
import { deriveAndroidDevice } from './derivedDevice';
import { operationRequestOf, operationRoute } from './operationRoute';
import { CHECK_BUDGET_MS, capabilitiesFor, secretsOf } from './qrRuntime';
import { failureResponse, json } from './response';
import { createRouter } from './router';
import { createSealedSessionResolver } from './sealedResolver';

/**
 * The serverless entry point: one Web-standard `handleRequest(request, env)` and nothing else.
 *
 * 🔴 This module must never import `src/app.ts`. Requiring the package root starts a Koa server as
 * an import side effect, which is correct for Node and fatal for a Worker. The dependency-closure
 * test asserts the whole graph, because "it does not import Koa" has been wrong before — `colors`
 * and the config barrel both arrived indirectly (M0 0.2).
 *
 * What this runtime can serve differs from Node, and says so rather than failing later:
 * - `wechat` always; `qq` only when the host injects a `QqQrRelay`. The QQ App channel is MQTT over
 *   WebSocket with a connection that must outlive one invocation — the CONNECT asks for a clean
 *   session and the subscription is unicast, so nothing published while disconnected is replayed.
 *   A host that can hold that connection (a Cloudflare Durable Object) passes a relay in; one that
 *   cannot (Vercel Functions) passes nothing and the channel is simply not advertised.
 *   🔴 A missing relay is a capability statement, not an error: `/login/channels` answers `wechat`.
 * - `sealed` sessions only. There is no process to keep a credential in.
 * - Without `QQ_SESSION_SECRET` the login routes answer 501 and the catalog routes still work.
 *   🔴 A secret is never generated: a process-local one would put back exactly the "restart loses
 *   every login" bug this whole workstream exists to remove.
 */

/**
 * Re-exported so a host can implement the relay without importing the package root, which starts a
 * Koa server as an import side effect and is therefore unusable from a Worker.
 */
export type { QqQrRelay, QrEvent } from '../services/auth/qrLogin';

export interface ServerlessEnv {
  QQ_PLAYBACK_HINTS_ENABLED?: string;
  /** 没有 relay 时手机 QQ 走纯 HTTP 扫码；设 `0` 或 `false` 关掉。 */
  QQ_PTLOGIN_HTTP_ENABLED?: string;
  QQ_SESSION_SECRET?: string;
  QQ_SESSION_SECRET_PREVIOUS?: string;
  QQ_UNVERIFIED_WRITES_ENABLED?: string;
}

/**
 * Host capabilities that are not environment strings.
 *
 * Kept out of `ServerlessEnv` on purpose: `env` is a plain string map every platform can produce,
 * and a platform binding is not a string. Passing this separately is also what keeps the two-argument
 * `handleRequest(request, env)` signature — and therefore the Vercel entry — unchanged.
 */
export interface ServerlessOptions {
  /** Supplied only by a host that can hold an MQTT connection across invocations. */
  qqRelay?: QqQrRelay;
}

/** A single invocation may observe a pull channel this long before it has to answer. */

/** Header > query > cookie, the same order the Koa controller applies (§5.3 #2). */
const authTokenOf = (request: Request, url: URL): string | undefined => {
  const header = request.headers.get(AUTH_HEADER_NAME)?.trim();
  if (header) return header;
  const queried = tokenFromCookieString(url.searchParams.get('cookie') ?? '');
  if (queried) return queried;
  return tokenFromCookieString(request.headers.get('cookie') ?? '');
};

const tokenSourceOf = (request: Request, url: URL): 'header' | 'query' | 'cookie' | undefined => {
  if (request.headers.get(AUTH_HEADER_NAME)?.trim()) return 'header';
  if (tokenFromCookieString(url.searchParams.get('cookie') ?? '')) return 'query';
  if (tokenFromCookieString(request.headers.get('cookie') ?? '')) return 'cookie';
  return undefined;
};

interface RouteContext {
  request: Request;
  url: URL;
  params: Record<string, string>;
  /**
   * Lazy on purpose. Building the service derives the device identity from the session secret,
   * and the catalog routes are required to work on a deployment that has no secret at all — so
   * constructing it eagerly would make anonymous catalog requests fail on a missing secret.
   */
  service: () => Promise<QrLoginService>;
  token: string | undefined;
  tokenSource?: 'header' | 'query' | 'cookie';
  /**
   * The QR routes below build their own per-call `QrLoginService` (§ sealed QR state) instead of
   * using `service()`, because each of the three calls needs different wiring — `/key` captures
   * what it creates, `/create` and `/check` replay a session reconstructed from the `unikey`.
   */
  env: ServerlessEnv;
  options: ServerlessOptions;
}

type RouteHandler = (context: RouteContext) => Promise<Response>;

// 路由表由 manifest 生成。/login/channels 在入口最前面单独处理（不注册旧曲库传输、不接异常），
// 不进这张表。
const routes: Record<string, RouteHandler> = Object.fromEntries(
  sharedRoutes
    .filter((route) => route.name !== 'loginChannels')
    .map((route) => [
      serverlessPathOf(route),
      operationRoute(
        route.accountWrite ? protectAccountWrite(route.handler) : route.handler,
        route.strictRequest,
      ),
    ]),
);

const PRIVATE_ROUTES = new Set(
  sharedRoutes.filter((route) => route.strictRequest && route.needsSecret).map(serverlessPathOf),
);
const ACCOUNT_WRITE_ROUTES = new Set(
  sharedRoutes.filter((route) => route.accountWrite).map(serverlessPathOf),
);

const STRICT_GET_ROUTES = new Set(
  sharedRoutes
    .filter((route) => route.strictRequest && route.method === 'GET')
    .map((route) => serverlessPathOf(route)),
);

const NO_SECRET =
  'QQ_SESSION_SECRET is not set, so this deployment cannot hold a session. Catalog routes still work.';

/** The routes that need a session secret to mean anything. Catalog routes work without one. */
const LOGIN_ROUTES = new Set(
  sharedRoutes.filter((route) => route.needsSecret).map((route) => serverlessPathOf(route)),
);

const match = createRouter(routes);

/**
 * Built per invocation. A Worker may reuse an isolate across requests, and a service holding a
 * cookie jar and QR state from someone else's request is a cross-request leak, not a cache.
 */
const createServiceFor = async (
  env: ServerlessEnv,
  options: ServerlessOptions,
): Promise<QrLoginService> => {
  const secrets = secretsOf(env);
  return createQrLoginService({
    http: createFetchAuthHttpClient(),
    playbackHintsEnabled: !['0', 'false'].includes(env.QQ_PLAYBACK_HINTS_ENABLED ?? ''),
    createSessionHttp: () => createFetchAuthHttpClient(),
    deviceRepository: createMemoryDeviceContextRepository(
      await deriveAndroidDevice(secrets.current),
    ),
    sessionResolver: createSealedSessionResolver({ secrets }),
    capabilities: capabilitiesFor(options, env),
    checkBudgetMs: CHECK_BUDGET_MS,
  });
};

const handleRequestInner = async (
  request: Request,
  env: ServerlessEnv = {},
  options: ServerlessOptions = {},
): Promise<Response> => {
  const url = new URL(request.url);
  const configured = Boolean(env.QQ_SESSION_SECRET);

  if (url.pathname === '/login/channels' || url.pathname === '/login/channels/') {
    return operationRoute(loginChannels)({
      url,
      env,
      options,
      params: {},
      token: undefined,
      service: () => createServiceFor(env, options),
    });
  }

  const matched = match(url.pathname);
  if (!matched) {
    return json(
      {
        code: 501,
        message: `${url.pathname} is not implemented by the serverless runtime. See /login/channels for what this deployment serves.`,
      },
      501,
    );
  }

  if (STRICT_GET_ROUTES.has(matched.route) && !['GET', 'HEAD'].includes(request.method))
    return json({ code: 405, message: 'Method Not Allowed' }, 405, { Allow: 'GET, HEAD' });

  if (ACCOUNT_WRITE_ROUTES.has(matched.route)) {
    const refused = refusedAccountWrite(
      operationRequestOf({
        request,
        url,
        params: matched.params,
        env,
        options,
        token: authTokenOf(request, url),
        tokenSource: tokenSourceOf(request, url),
        service: () => createServiceFor(env, options),
      }),
    );
    if (refused) return json(refused.body, refused.status, refused.headers);
  }

  // 🔴 Explicit, never a silent downgrade. Without a secret there is no key to seal a session
  // with, and generating one per isolate would make every login vanish on the next cold start.
  if (!configured && LOGIN_ROUTES.has(matched.route)) {
    return json({ code: 501, message: NO_SECRET }, 501);
  }

  // The legacy catalog transport is a module-level registration, so it is set before any catalog
  // service can run. Re-registering an equivalent transport is idempotent.
  setLegacyHttpTransport(createFetchLegacyTransport());

  // Memoised per invocation: a handler may reach for it more than once, and a Worker isolate is
  // shared across requests, so the service (with its cookie jar and QR state) must not outlive one.
  let pending: Promise<QrLoginService> | null = null;
  const service = () => {
    pending ??= createServiceFor(env, options);
    return pending;
  };

  try {
    return await matched.handler({
      request,
      url,
      params: matched.params,
      service,
      token: authTokenOf(request, url),
      tokenSource: tokenSourceOf(request, url),
      env,
      options,
    });
  } catch (error) {
    return failureResponse(error);
  }
};

export const handleRequest = async (
  request: Request,
  env: ServerlessEnv = {},
  options: ServerlessOptions = {},
): Promise<Response> => {
  const matched = match(new URL(request.url).pathname);
  const response = await handleRequestInner(request, env, options);
  if (matched && PRIVATE_ROUTES.has(matched.route))
    response.headers.set('Cache-Control', 'private, no-store');
  return response;
};

export default handleRequest;
