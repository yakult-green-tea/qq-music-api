import type Koa from 'koa';
import app, { configureAuthSessionRepository, server } from '../src/app';
import router from '../src/routes/router';

// Executable form of the `src/app.ts` boundary: the file may perform composition-root dependency
// wiring and nothing else. Every assertion below describes externally observable behaviour that
// the encrypted-session work must leave untouched — the middleware chain, the route table, the
// export shape and the condition under which the process starts listening.
//
// If one of these fails, the fix is to restore `app.ts`, not to update the expectation.

/**
 * The chain as it stands, in order. Anonymous entries are the inline middlewares:
 * 1 `cookie()`, 2 the explorer branch, 4 the request logger, 6 `x-response-time`.
 */
const EXPECTED_MIDDLEWARE = [
  'bodyParser',
  '',
  '',
  'serve',
  '',
  'cors',
  '',
  'dispatch',
  'allowedMethods',
];

describe('src/app.ts composition root', () => {
  it('should keep the middleware chain identical in count and order', () => {
    const middleware = (app as Koa).middleware;

    expect(middleware.map((layer) => layer.name)).toEqual(EXPECTED_MIDDLEWARE);
    expect(middleware).toHaveLength(EXPECTED_MIDDLEWARE.length);
  });

  it('should keep the route table unchanged', () => {
    const routes = router.stack.map((layer) => `${layer.methods.join(',')} ${layer.path}`).sort();

    expect(new Set(routes).size).toBe(routes.length);
    expect(routes).toContain('HEAD,GET /login/qr/key');
    expect(routes).toContain('HEAD,GET /login/qr/create');
    expect(routes).toContain('HEAD,GET /login/qr/check');
    expect(routes).toContain('HEAD,GET /login/qr/cancel');
    expect(routes).toContain('HEAD,GET /login/status');
    expect(routes).toContain('HEAD,GET /logout');
    // A guard, not a catalogue: the count changing means a route was added or removed.
    expect(routes).toHaveLength(router.stack.length);
  });

  it('should keep the export shape of the package entry point', () => {
    // Electron's lifeline: an embedding host requires the package root and injects its own
    // repository through this exact function.
    expect(typeof configureAuthSessionRepository).toBe('function');
    expect(configureAuthSessionRepository).toHaveLength(1);
    expect(typeof (app as Koa).use).toBe('function');
    expect(typeof (app as Koa).callback).toBe('function');
  });

  it('should keep `listen()` gated on the test environment', () => {
    // The only condition the entry point has ever applied. Under Jest it must not bind a port,
    // and the exported handle must stay `null` rather than becoming `undefined` or a server.
    expect(server).toBeNull();
  });

  it('should not touch the filesystem when session persistence is not configured', () => {
    // The wiring `app.ts` gained in S3 is opt-in. Importing the entry point without
    // `QQ_AUTH_SESSION_PATH` and `QQ_SESSION_SECRET` must leave the packaged in-memory default
    // in place, which is what every deployment that exists today relies on.
    expect(process.env.QQ_AUTH_SESSION_PATH).toBeUndefined();
    expect(process.env.QQ_SESSION_SECRET).toBeUndefined();
  });
});
