jest.mock('../src/routes/manifest', () => {
  const original =
    jest.requireActual<typeof import('../src/routes/manifest')>('../src/routes/manifest');
  const routes = original.sharedRoutes.map((route) =>
    route.strictRequest && route.needsSecret
      ? {
          ...route,
          handler: async (request: import('../src/routes/operations/types').OperationRequest) => {
            const failed = request.query('fail') === '1';
            return { status: failed ? 502 : 200, headers: {}, body: { code: failed ? 502 : 200 } };
          },
        }
      : route,
  );
  return { ...original, routeManifest: routes, sharedRoutes: routes };
});

import { sharedRoutes } from '../src/routes/manifest';
import { CATALOG_RUNTIMES, callRoute } from './helpers/catalogRoutes';

const routes = sharedRoutes.filter((route) => route.strictRequest && route.needsSecret);
describe.each(CATALOG_RUNTIMES)('private cache dispatch: %s', (runtime) => {
  it.each(
    routes.map((route) => [route.path, route.method] as const),
  )('%s protects successful and failed responses', async (path, method) => {
    for (const [query, status] of [
      ['', 200],
      ['?fail=1', 502],
    ] as const) {
      const result = await callRoute(runtime, `${path}${query}`, {
        method,
        ...(method === 'POST' ? { body: {} } : {}),
        env: { QQ_SESSION_SECRET: 'fixture-secret' },
        responseHeaders: ['cache-control'],
      });
      expect(result.status).toBe(status);
      expect(result.headers?.['cache-control']).toEqual(['private, no-store']);
    }
  });
});
