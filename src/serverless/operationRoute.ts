import type { OperationHandler, OperationRequest } from '../routes/operations/types';
import type { QrLoginService } from '../services/auth/qrLogin';
import type { ServerlessEnv, ServerlessOptions } from './index';
import { createServerlessQrOperations } from './qrOperations';
import { capabilitiesFor } from './qrRuntime';
import { json } from './response';

// src/serverless/operationRoute.ts
//
// serverless 这边的转接：把入口整理好的路由上下文交给共用 handler，再把结果写成 JSON 回应。
// 异常不在这里接，照旧由入口的 `failureResponse` 处理。

/** 入口路由上下文里转接用得到的部分。 */
export interface OperationRouteContext {
  request?: Request;
  env?: ServerlessEnv;
  options?: ServerlessOptions;
  url: URL;
  params: Record<string, string>;
  token: string | undefined;
  tokenSource?: 'header' | 'query' | 'cookie';
  service: () => Promise<QrLoginService>;
  strictRequest?: boolean;
}

export const operationRequestOf = ({
  url,
  params,
  token,
  tokenSource,
  service,
  env,
  options,
  request,
  strictRequest,
}: OperationRouteContext): OperationRequest => ({
  runtime: 'serverless',
  unverifiedWritesEnabled: env?.QQ_UNVERIFIED_WRITES_ENABLED === '1',
  method: request?.method ?? 'GET',
  body: async () => request?.json(),
  contentType: request?.headers.get('content-type') ?? undefined,
  query: (name) => url.searchParams.get(name) ?? undefined,
  queryRaw: (name) => {
    const values = url.searchParams.getAll(name);
    return strictRequest && values.length > 1 ? values : values[0];
  },
  params,
  token,
  tokenSource,
  fetchSite: request?.headers.get('sec-fetch-site') ?? undefined,
  sessionConfigured: Boolean(env?.QQ_SESSION_SECRET),
  service,
  qr: createServerlessQrOperations({ env: env ?? {}, options: options ?? {}, service }),
  capabilities: capabilitiesFor(options ?? {}, env ?? {}),
});

export const operationRoute =
  (handler: OperationHandler, strictRequest = false) =>
  async (context: OperationRouteContext): Promise<Response> => {
    const result = await handler(operationRequestOf({ ...context, strictRequest }));
    return json(result.body, result.status, result.headers);
  };
