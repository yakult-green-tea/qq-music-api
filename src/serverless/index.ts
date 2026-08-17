import getAlbumInfoService from '../services/album/getAlbumInfo';
import type { AndroidDevice } from '../services/auth/androidDevice';
import { createMemoryDeviceContextRepository } from '../services/auth/deviceContextStore';
import type { AuthHttpClient } from '../services/auth/httpClient';
import {
  createQrLoginService,
  type QrLoginService,
  QrLoginServiceError,
  type QrSessionRecord,
  type QrSessionRepository,
} from '../services/auth/qrLogin';
import { setLegacyHttpTransport } from '../services/httpTransport';
import songListDetailService from '../services/songLists/songListDetail';
import u_common from '../services/u_common';
import { AuthCredentialRejectedError } from '../util/authError';
import { deriveAndroidDevice } from './derivedDevice';
import { createFetchAuthHttpClient } from './fetchAuthHttpClient';
import { createFetchLegacyTransport } from './fetchLegacyTransport';
import { createRouter } from './router';
import { openQrState, type SealedQrDeviceStateV1, sealQrState } from './sealedQrState';
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
 * - `wechat` only. The QQ App channel is MQTT over WebSocket with a long-lived connection, which
 *   is not something a request-scoped invocation can hold. `/login/channels` advertises this.
 * - `sealed` sessions only. There is no process to keep a credential in.
 * - Without `QQ_SESSION_SECRET` the login routes answer 501 and the catalog routes still work.
 *   🔴 A secret is never generated: a process-local one would put back exactly the "restart loses
 *   every login" bug this whole workstream exists to remove.
 */

export interface ServerlessEnv {
  QQ_SESSION_SECRET?: string;
  QQ_SESSION_SECRET_PREVIOUS?: string;
}

const AUTH_COOKIE_NAME = 'qqmusic_session';
const AUTH_HEADER_NAME = 'x-qq-session';
/** A single invocation may observe a pull channel this long before it has to answer. */
const CHECK_BUDGET_MS = 20_000;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });

const tokenFromCookieString = (cookie: string): string | undefined => {
  for (const entry of cookie.split(';')) {
    const separator = entry.indexOf('=');
    if (separator <= 0) continue;
    if (entry.slice(0, separator).trim() === AUTH_COOKIE_NAME)
      return entry.slice(separator + 1).trim() || undefined;
  }
  return undefined;
};

/** Header > query > cookie, the same order the Koa controller applies (§5.3 #2). */
const authTokenOf = (request: Request, url: URL): string | undefined => {
  const header = request.headers.get(AUTH_HEADER_NAME)?.trim();
  if (header) return header;
  const queried = tokenFromCookieString(url.searchParams.get('cookie') ?? '');
  if (queried) return queried;
  return tokenFromCookieString(request.headers.get('cookie') ?? '');
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
  /**
   * The QR routes below build their own per-call `QrLoginService` (§ sealed QR state) instead of
   * using `service()`, because each of the three calls needs different wiring — `/key` captures
   * what it creates, `/create` and `/check` replay a session reconstructed from the `unikey`.
   */
  env: ServerlessEnv;
}

type RouteHandler = (context: RouteContext) => Promise<Response>;

/** Mirrors `setServiceError` in the Koa controller, including the `Retry-After` header. */
const serviceErrorResponse = (error: unknown): Response => {
  if (error instanceof QrLoginServiceError) {
    return json(
      {
        code: error.httpStatus,
        message: error.message,
        retryAfterMs: error.retryAfterMs,
        ...(error.upstreamCode === undefined ? {} : { upstreamCode: error.upstreamCode }),
      },
      error.httpStatus,
      error.retryAfterMs
        ? { 'retry-after': String(Math.ceil(error.retryAfterMs / 1000)) }
        : undefined,
    );
  }
  throw error;
};

const LOGIN_REQUIRED = { code: 401, message: 'Login required' };

const secretsOf = (env: ServerlessEnv) => ({
  current: env.QQ_SESSION_SECRET ?? '',
  previous: env.QQ_SESSION_SECRET_PREVIOUS,
});

const QR_CAPABILITIES = { channels: ['wechat'] as const, sessionMode: 'sealed' as const };

/**
 * A `QrSessionRepository` that answers `load()` with exactly the record a sealed `unikey` was
 * opened into, and never actually persists anything `/login/qr/create` or `/login/qr/check`
 * mutate — there is nowhere to write it back to, and nothing past this one call needs it.
 */
const replayQrSessionRepository = (records: QrSessionRecord[]): QrSessionRepository => ({
  kind: 'sealed-replay',
  load: () => records,
  save: () => undefined,
});

/**
 * A `QrSessionRepository` that starts empty and remembers the last thing saved into it, so
 * `/login/qr/key` can read back the record `createSession` + `createQr` just built — the state
 * that has to be sealed into the `unikey` — without `QrLoginService` exposing it directly.
 */
const capturingQrSessionRepository = (): {
  repository: QrSessionRepository;
  latest: () => QrSessionRecord[];
} => {
  let saved: QrSessionRecord[] = [];
  return {
    repository: {
      kind: 'sealed-capture',
      load: () => [],
      save: (sessions) => {
        saved = sessions.slice();
      },
    },
    latest: () => saved,
  };
};

/** Layers the live fields a fresh isolate cannot re-derive onto the deterministic base device. */
const withQrDeviceState = (base: AndroidDevice, saved?: SealedQrDeviceStateV1): AndroidDevice =>
  saved
    ? {
        ...base,
        ...(saved.qimei === undefined ? {} : { qimei: saved.qimei }),
        ...(saved.qimei36 === undefined ? {} : { qimei36: saved.qimei36 }),
        ...(saved.qimeiSavedAt === undefined ? {} : { qimeiSavedAt: saved.qimeiSavedAt }),
        ...(saved.sessionUid === undefined ? {} : { sessionUid: saved.sessionUid }),
        ...(saved.sessionSid === undefined ? {} : { sessionSid: saved.sessionSid }),
        ...(saved.sessionVkey === undefined ? {} : { sessionVkey: saved.sessionVkey }),
      }
    : base;

const qrDeviceRepositoryFor = async (
  secrets: { current: string; previous?: string },
  saved?: SealedQrDeviceStateV1,
) =>
  createMemoryDeviceContextRepository(
    withQrDeviceState(await deriveAndroidDevice(secrets.current), saved),
  );

const routes: Record<string, RouteHandler> = {
  // ---- QR login ---------------------------------------------------------------------------
  /**
   * D1′: the whole upstream QR round trip — `createSession` (QIMEI + Android session bootstrap)
   * and `createQr` (the WeChat web QR itself) — happens right here, inside the one invocation
   * that gets to return a `unikey`. That is what lets everything a later `/create` or `/check`
   * needs be sealed into that same token: there is no second invocation in which to discover the
   * WeChat `identifier` and then hand out a *different* key carrying it.
   */
  '/login/qr/key': async ({ url, env }) => {
    // WeChat is the only channel this runtime declares, so an explicit `channel` is validated
    // against the capabilities rather than against the Node channel list.
    const channel = url.searchParams.get('channel') ?? 'wechat';
    const secrets = secretsOf(env);
    const deviceRepository = await qrDeviceRepositoryFor(secrets);
    const qrSessions = capturingQrSessionRepository();
    let qrSessionHttp: AuthHttpClient | undefined;
    const service = createQrLoginService({
      http: createFetchAuthHttpClient(),
      createSessionHttp: () => (qrSessionHttp = createFetchAuthHttpClient()),
      deviceRepository,
      sessionResolver: createSealedSessionResolver({ secrets }),
      qrSessionRepository: qrSessions.repository,
      capabilities: QR_CAPABILITIES,
      checkBudgetMs: CHECK_BUDGET_MS,
    });
    try {
      const key = await service.createSession(channel as 'qq' | 'wechat');
      await service.createQr(key);
      const record = qrSessions.latest().find((session) => session.key === key);
      // `createQr` either finished with `identifier`/`imageUrl` on this exact record or threw —
      // reaching here without both would be a bug in this function, not a caller error.
      if (!record?.identifier || !record.imageUrl) {
        throw new Error('QR session has no upstream QR after createQr()');
      }
      const device = deviceRepository.load() ?? (await deriveAndroidDevice(secrets.current));
      const unikey = await sealQrState(
        {
          channel: record.channel,
          createdAt: record.createdAt,
          expiresAt: record.expiresAt,
          identifier: record.identifier,
          imageUrl: record.imageUrl,
          // The WeChat web flow's cookie jar at the moment the QR was created — see the module
          // doc on `sealedQrState.ts` for why a fresh isolate cannot rebuild this on its own.
          cookies: qrSessionHttp?.getCookieHeader() ?? '',
          device: {
            qimei: device.qimei,
            qimei36: device.qimei36,
            qimeiSavedAt: device.qimeiSavedAt,
            sessionUid: device.sessionUid,
            sessionSid: device.sessionSid,
            sessionVkey: device.sessionVkey,
          },
        },
        secrets.current,
      );
      return json({ code: 200, data: { unikey } });
    } catch (error) {
      return serviceErrorResponse(error);
    }
  },

  /**
   * Never calls upstream. The sealed `unikey` already carries the `imageUrl` `/login/qr/key`
   * fetched; `createQr()` is idempotent on an already-imaged session and simply hands it back —
   * the same short-circuit that makes a duplicate call from the Koa controller a no-op.
   */
  '/login/qr/create': async ({ url, env }) => {
    const key = url.searchParams.get('key');
    if (!key) return json({ code: 400, message: 'key is required' }, 400);
    const secrets = secretsOf(env);
    const payload = await openQrState(key, secrets, Date.now());
    if (!payload) {
      return serviceErrorResponse(new QrLoginServiceError('QR session not found or expired', 404));
    }
    const service = createQrLoginService({
      http: createFetchAuthHttpClient(),
      createSessionHttp: () => createFetchAuthHttpClient({ initialCookies: payload.cookies }),
      deviceRepository: await qrDeviceRepositoryFor(secrets, payload.device),
      sessionResolver: createSealedSessionResolver({ secrets }),
      qrSessionRepository: replayQrSessionRepository([
        {
          key,
          channel: payload.channel,
          state: 'waiting',
          createdAt: payload.createdAt,
          expiresAt: payload.expiresAt,
          identifier: payload.identifier,
          imageUrl: payload.imageUrl,
        },
      ]),
      capabilities: QR_CAPABILITIES,
      checkBudgetMs: CHECK_BUDGET_MS,
    });
    try {
      return json({ code: 200, data: { qrimg: await service.createQr(key) } });
    } catch (error) {
      return serviceErrorResponse(error);
    }
  },

  '/login/qr/check': async ({ url, env }) => {
    const key = url.searchParams.get('key');
    if (!key) return json({ code: 400, message: 'key is required' }, 400);
    const secrets = secretsOf(env);
    const payload = await openQrState(key, secrets, Date.now());
    // A missing, tampered or expired `unikey` leaves the replay repository empty. `checkQr`'s own
    // catch-all then answers `{code:800}` for "session not found" exactly as it does for the
    // in-memory store it replaces — no special case needed here.
    const service = createQrLoginService({
      http: createFetchAuthHttpClient(),
      createSessionHttp: () =>
        createFetchAuthHttpClient({ initialCookies: payload?.cookies ?? '' }),
      deviceRepository: await qrDeviceRepositoryFor(secrets, payload?.device),
      sessionResolver: createSealedSessionResolver({ secrets }),
      qrSessionRepository: replayQrSessionRepository(
        payload
          ? [
              {
                key,
                channel: payload.channel,
                state: 'waiting',
                createdAt: payload.createdAt,
                expiresAt: payload.expiresAt,
                identifier: payload.identifier,
                imageUrl: payload.imageUrl,
              },
            ]
          : [],
      ),
      capabilities: QR_CAPABILITIES,
      checkBudgetMs: CHECK_BUDGET_MS,
    });
    const result = await service.checkQr(key, CHECK_BUDGET_MS);
    // §5.3 #1: the body keeps `{ code, message, cookie }`. The Set-Cookie mirrors what the Koa
    // route does, but the client reads `body.cookie` — it has never parsed the token.
    const token =
      result.code === 803 && result.cookie ? tokenFromCookieString(result.cookie) : null;
    return json(
      result,
      200,
      token
        ? {
            'set-cookie': `${AUTH_COOKIE_NAME}=${token}; HttpOnly; Max-Age=86400; SameSite=Lax; Path=/`,
          }
        : undefined,
    );
  },

  '/login/qr/cancel': async ({ url, service: getService }) => {
    const key = url.searchParams.get('key');
    if (!key) return json({ code: 400, message: 'key is required' }, 400);
    // §5.3 #5: always 200. Callers cancel fire-and-forget on dialog close.
    (await getService()).cancelSession(key);
    return json({ code: 200 });
  },

  // ---- Session ----------------------------------------------------------------------------
  '/login/status': async ({ service: getService, token }) => {
    // §5.3 #3: never 401 here. Folia decides by whether `data.profile` exists.
    const profile = await (await getService()).getLoginStatus(token);
    return json({ code: 200, data: profile ? { profile } : {} });
  },

  '/logout': async ({ service: getService, token }) => {
    // 🔴 Under `sealed` this cannot delete anything: the session lives in the token the client
    // holds. `revoke()` is a documented no-op and logout means the client discarding it. The
    // expired cookie below is what actually ends the session for a same-origin caller.
    await (await getService()).logout(token);
    return json({ code: 200 }, 200, { 'set-cookie': `${AUTH_COOKIE_NAME}=; Max-Age=0; Path=/` });
  },

  '/user/detail': async ({ service: getService, token }) => {
    const profile = await (await getService()).getUserDetail(token);
    return profile ? json({ code: 200, profile }) : json(LOGIN_REQUIRED, 401);
  },

  '/user/playlist': async ({ url, service: getService, token }) => {
    const data = await (await getService()).getUserPlaylists(
      token,
      url.searchParams.get('uid') ?? undefined,
    );
    if (!data) return json(LOGIN_REQUIRED, 401);
    const playlist = Array.isArray(data.v_playlist) ? data.v_playlist : [];
    return json({
      code: 200,
      playlist,
      total: typeof data.total === 'number' ? data.total : playlist.length,
      more: data.bFinish === false,
    });
  },

  '/user/albums': async ({ url, service: getService, token }) => {
    const offset = Math.max(0, Number.parseInt(url.searchParams.get('offset') ?? '0', 10) || 0);
    const limit = Math.min(
      100,
      Math.max(1, Number.parseInt(url.searchParams.get('limit') ?? '20', 10) || 20),
    );
    const data = await (await getService()).getUserAlbums(token, offset, limit);
    if (!data) return json(LOGIN_REQUIRED, 401);
    const albums = Array.isArray(data.albumlist) ? data.albumlist : [];
    const total = typeof data.totalalbum === 'number' ? data.totalalbum : albums.length;
    return json({
      code: 200,
      albums,
      total,
      more: Number(data.has_more) === 1 || offset + albums.length < total,
    });
  },

  '/user/liked-songs': async ({ url, service: getService, token }) => {
    const offset = Math.max(0, Number.parseInt(url.searchParams.get('offset') ?? '0', 10) || 0);
    const limit = Math.min(
      100,
      Math.max(1, Number.parseInt(url.searchParams.get('limit') ?? '100', 10) || 100),
    );
    const data = await (await getService()).getUserLikedSongs(token, offset, limit);
    if (!data) return json(LOGIN_REQUIRED, 401);
    const songs = Array.isArray(data.songlist) ? data.songlist : [];
    const total = typeof data.total_song_num === 'number' ? data.total_song_num : songs.length;
    return json({
      code: 200,
      songs,
      total,
      more: data.hasmore === true || Number(data.hasmore) === 1 || offset + songs.length < total,
    });
  },

  '/getMusicPlay/:songmid?': async ({ url, params, service: getService, token }) => {
    const songmid = (params.songmid ?? url.searchParams.get('songmid') ?? '').trim();
    if (!songmid) return json({ data: { message: 'no songmid' } }, 400);
    // Only the authenticated branch is served here. The Node controller also has an anonymous
    // fallback that builds a guessed URL from `config.user`, which a serverless deployment has
    // no configuration file for; without a session there is nothing honest to answer.
    if (!token) return json(LOGIN_REQUIRED, 401);
    const playUrl = await (await getService()).getMusicPlay(
      token,
      songmid,
      url.searchParams.get('quality') ?? '128',
      url.searchParams.get('mediaId') ?? undefined,
    );
    return playUrl ? json({ data: { playUrl } }) : json(LOGIN_REQUIRED, 401);
  },

  // ---- Catalog (no credential) ------------------------------------------------------------
  '/getSongListDetail/:disstid': async ({ url, params }) => {
    const disstid = params.disstid ?? url.searchParams.get('disstid') ?? undefined;
    const { status, body } = await songListDetailService({
      method: 'get',
      params: { disstid },
      option: {},
    });
    return json(body, status);
  },

  '/getSongInfo/:songmid/:songid?': async ({ url, params }) => {
    const song_mid = params.songmid ?? url.searchParams.get('songmid') ?? undefined;
    const song_id = params.songid ?? url.searchParams.get('songid') ?? '';
    const response = await u_common({
      method: 'get',
      options: {
        params: {
          format: 'json',
          data: JSON.stringify({
            comm: { ct: 24, cv: 0 },
            songinfo: {
              method: 'get_song_detail_yqq',
              param: { song_type: 0, song_mid, song_id },
              module: 'music.pf_song_detail_svr',
            },
          }),
        },
      },
    });
    return json({ response: response.data });
  },

  '/getAlbumInfo': async ({ url }) => {
    const albummid = url.searchParams.get('albummid');
    if (!albummid) return json({ data: { message: 'no albummid' } }, 400);
    const { status, body } = await getAlbumInfoService({
      method: 'get',
      params: { albummid },
      options: {},
    });
    return json(body, status);
  },

  '/getSingerAlbum': async ({ url }) => {
    const singermid = url.searchParams.get('singermid');
    if (!singermid) return json({ data: { message: 'no singermid' } }, 400);
    const num = +(url.searchParams.get('limit') || 5);
    const begin = +(url.searchParams.get('page') || 0);
    const response = await u_common({
      method: 'get',
      options: {
        params: {
          format: 'json',
          singermid,
          data: JSON.stringify({
            comm: { ct: 24, cv: 0 },
            singer: {
              method: 'GetAlbumList',
              param: { sort: 5, singermid, begin, num },
              module: 'music.musichallAlbum.AlbumListServer',
            },
          }),
        },
      },
    });
    return json({ response: response.data });
  },

  '/getSingerHotsong': async ({ url }) => {
    const singermid = url.searchParams.get('singermid');
    if (!singermid) return json({ data: { message: 'no singermid' } }, 400);
    const num = +(url.searchParams.get('limit') || 5);
    const page = +(url.searchParams.get('page') || 0);
    const response = await u_common({
      method: 'get',
      options: {
        params: {
          format: 'json',
          singermid,
          data: JSON.stringify({
            comm: { ct: 24, cv: 0 },
            singer: {
              method: 'get_singer_detail_info',
              param: { sort: 5, singermid, sin: (page - 1) * num, num },
              module: 'music.web_singer_info_svr',
            },
          }),
        },
      },
    });
    return json({ response: response.data });
  },
};

/** The routes that need a session secret to mean anything. Catalog routes work without one. */
const LOGIN_ROUTES = new Set([
  '/login/qr/key',
  '/login/qr/create',
  '/login/qr/check',
  '/login/qr/cancel',
  '/login/status',
  '/logout',
  '/user/detail',
  '/user/playlist',
  '/user/albums',
  '/user/liked-songs',
  '/getMusicPlay/:songmid?',
]);

const match = createRouter(routes);

/**
 * Built per invocation. A Worker may reuse an isolate across requests, and a service holding a
 * cookie jar and QR state from someone else's request is a cross-request leak, not a cache.
 */
const createServiceFor = async (env: ServerlessEnv): Promise<QrLoginService> => {
  const secrets = secretsOf(env);
  return createQrLoginService({
    http: createFetchAuthHttpClient(),
    createSessionHttp: () => createFetchAuthHttpClient(),
    deviceRepository: createMemoryDeviceContextRepository(
      await deriveAndroidDevice(secrets.current),
    ),
    sessionResolver: createSealedSessionResolver({ secrets }),
    capabilities: { channels: ['wechat'], sessionMode: 'sealed' },
    checkBudgetMs: CHECK_BUDGET_MS,
  });
};

export const handleRequest = async (
  request: Request,
  env: ServerlessEnv = {},
): Promise<Response> => {
  const url = new URL(request.url);
  const configured = Boolean(env.QQ_SESSION_SECRET);

  if (url.pathname === '/login/channels' || url.pathname === '/login/channels/') {
    return json({
      code: 200,
      data: { channels: ['wechat'], sessionMode: 'sealed', configured },
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

  // 🔴 Explicit, never a silent downgrade. Without a secret there is no key to seal a session
  // with, and generating one per isolate would make every login vanish on the next cold start.
  if (!configured && LOGIN_ROUTES.has(matched.route)) {
    return json(
      {
        code: 501,
        message:
          'QQ_SESSION_SECRET is not set, so this deployment cannot hold a session. Catalog routes still work.',
      },
      501,
    );
  }

  // The legacy catalog transport is a module-level registration, so it is set before any catalog
  // service can run. Re-registering an equivalent transport is idempotent.
  setLegacyHttpTransport(createFetchLegacyTransport());

  // Memoised per invocation: a handler may reach for it more than once, and a Worker isolate is
  // shared across requests, so the service (with its cookie jar and QR state) must not outlive one.
  let pending: Promise<QrLoginService> | null = null;
  const service = () => {
    pending ??= createServiceFor(env);
    return pending;
  };

  try {
    return await matched.handler({
      request,
      url,
      params: matched.params,
      service,
      token: authTokenOf(request, url),
      env,
    });
  } catch (error) {
    // Same split the Koa error middleware applies: an upstream credential rejection is a 401 the
    // client can act on, everything else is a 500.
    if (error instanceof AuthCredentialRejectedError)
      return json({ code: error.httpStatus, message: error.message }, error.httpStatus);
    return json({ error: error instanceof Error ? error.message : 'Unknown error' }, 500);
  }
};

export default handleRequest;
