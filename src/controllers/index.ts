import type { Context, Next } from 'koa';
import { type RouteName, routeManifest } from '../routes/manifest';
import { protectAccountWrite } from '../routes/operations/writeSafety';
import { withControllerLogging } from '../util/observability';
import logoutOperationController from './logoutOperation';
import musicPlayOperationController from './musicPlayOperation';
import { operationController } from './operation';
import qrCheckOperationController from './qrCheckOperation';

type Controller = (ctx: Context, next: Next) => Promise<unknown> | unknown;

/**
 * 共用路由在 Node 上另有转接的：要用 Koa 的 Cookie 等 API 的三条，以及 Node 上仍走原来
 * controller 的 /getLyric。其余的都直接用 `operationController(handler)`。
 */
const nodeAdapters: Partial<Record<RouteName, Controller>> = {
  qrCheck: qrCheckOperationController,
  logout: logoutOperationController,
  getMusicPlay: musicPlayOperationController,
};

const controllerOf = (route: (typeof routeManifest)[number]): Controller => {
  const accountWrite = 'accountWrite' in route && route.accountWrite;
  const handler = accountWrite ? protectAccountWrite(route.handler) : route.handler;
  return nodeAdapters[route.name] ?? operationController(handler);
};

export default Object.fromEntries(
  routeManifest.map((route) => [
    route.name,
    withControllerLogging(route.name, controllerOf(route)),
  ]),
) as Record<RouteName, ReturnType<typeof withControllerLogging>>;
