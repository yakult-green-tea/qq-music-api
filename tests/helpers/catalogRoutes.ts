import request from 'supertest';
import app from '../../src/app';
import { handleRequest, type ServerlessEnv, type ServerlessOptions } from '../../src/serverless';
import {
  getLegacyHttpTransport,
  type LegacyHttpTransport,
  setLegacyHttpTransport,
} from '../../src/services/httpTransport';

/**
 * Runs one catalog route case on both hosts against the same synthetic musicu upstream.
 *
 * Node keeps its real controller and service and only swaps the legacy transport; serverless keeps
 * its real handler and fetch transport and only swaps `fetch`. Every recorded call is reduced to
 * the fields both hosts send, so one expectation covers both.
 */

export type CatalogRuntimeName = 'node' | 'serverless';

export interface RouteResult {
  status: number;
  body: unknown;
  /** 只有请求指定要比较的标头才收集，旧曲库案例保持原来的结果形状。 */
  headers?: Record<string, string[]>;
}

export interface RouteCallOptions {
  method?: 'GET' | 'POST' | 'DELETE' | 'HEAD';
  body?: unknown;
  headers?: Record<string, string>;
  env?: ServerlessEnv;
  options?: ServerlessOptions;
  responseHeaders?: readonly string[];
}

export const selectedHeaders = (
  names: readonly string[] | undefined,
  read: (name: string) => string | string[] | undefined | null,
): Pick<RouteResult, 'headers'> =>
  names === undefined
    ? {}
    : {
        headers: Object.fromEntries(
          names.map((name) => {
            const value = read(name);
            return [
              name.toLowerCase(),
              value == null ? [] : Array.isArray(value) ? value : [value],
            ];
          }),
        ),
      };

export interface UpstreamCall {
  endpoint: string;
  format?: unknown;
  singermid?: unknown;
  /** musicu 请求里 `data` 解析后的内容。 */
  payload?: unknown;
  /** 其他 CGI 请求的查询参数，值统一成字符串（两种宿主送出时都会变成字符串）。 */
  params?: Record<string, string>;
}

type Reply = { body: unknown } | { error: unknown };

const MUSICU_URL = 'https://u.y.qq.com/cgi-bin/musicu.fcg';
const CGI_BASE = { c: 'https://c.y.qq.com', y: 'https://y.qq.com' };

/** Node 的 transport 收到的是相对路径和 target，换成与 fetch 相同的完整地址。 */
const nodeEndpoint = (url: string, target?: string): string => {
  if (target === 'u') return MUSICU_URL;
  if (/^https?:\/\//.test(url)) return url;
  return `${target === 'y' ? CGI_BASE.y : CGI_BASE.c}${url}`;
};

const toCall = (endpoint: string, params: Record<string, unknown>): UpstreamCall => {
  if (endpoint !== MUSICU_URL)
    return {
      endpoint,
      params: Object.fromEntries(
        Object.entries(params)
          .filter(([, value]) => value !== undefined && value !== null)
          .map(([key, value]) => [key, String(value)]),
      ),
    };
  return {
    endpoint,
    ...(params.format === undefined ? {} : { format: params.format }),
    ...(params.singermid === undefined ? {} : { singermid: params.singermid }),
    payload: typeof params.data === 'string' ? JSON.parse(params.data) : undefined,
  };
};

/** Call from inside a `describe`; it installs and removes the stub around every test. */
export const useCatalogUpstream = (runtime: CatalogRuntimeName) => {
  const calls: UpstreamCall[] = [];
  let reply: Reply = { error: new Error('No upstream reply configured') };
  let original: LegacyHttpTransport | undefined;
  let fetchSpy: jest.SpyInstance | undefined;

  beforeEach(() => {
    calls.length = 0;
    reply = { error: new Error('No upstream reply configured') };
    if (runtime === 'node') {
      original = getLegacyHttpTransport();
      const base = original;
      setLegacyHttpTransport({
        kind: base.kind,
        get defaults() {
          return base.defaults;
        },
        request: async <T>(
          url: string,
          _method: string,
          options: { params?: Record<string, unknown> } = {},
          target?: string,
        ) => {
          calls.push(toCall(nodeEndpoint(url, target), options.params ?? {}));
          if ('error' in reply) throw reply.error;
          return { data: reply.body as T, status: 200, statusText: 'OK', headers: {}, config: {} };
        },
      } as LegacyHttpTransport);
    } else {
      fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        calls.push(
          toCall(`${url.origin}${url.pathname}`, Object.fromEntries(url.searchParams.entries())),
        );
        if ('error' in reply) throw reply.error;
        return Response.json(reply.body);
      });
    }
  });

  afterEach(() => {
    if (original) setLegacyHttpTransport(original);
    original = undefined;
    fetchSpy?.mockRestore();
    fetchSpy = undefined;
  });

  return {
    calls,
    respond: (body: unknown) => {
      reply = { body };
    },
    fail: (error: unknown) => {
      reply = { error };
    },
  };
};

const server = app.callback();

export const callRoute = async (
  runtime: CatalogRuntimeName,
  path: string,
  options: RouteCallOptions = {},
): Promise<RouteResult> => {
  if (runtime === 'node') {
    const pending =
      options.method === 'POST'
        ? request(server).post(path)
        : options.method === 'DELETE'
          ? request(server).delete(path)
          : options.method === 'HEAD'
            ? request(server).head(path)
            : request(server).get(path);
    pending.set(options.headers ?? {});
    if (options.body !== undefined)
      pending
        .set('Content-Type', options.headers?.['Content-Type'] ?? 'application/json')
        .send(JSON.stringify(options.body));
    const response = await pending;
    return {
      status: response.status,
      body: response.body,
      ...selectedHeaders(options.responseHeaders, (name) => response.headers[name.toLowerCase()]),
    };
  }
  const response = await handleRequest(
    new Request(`https://worker.invalid${path}`, {
      method: options.method ?? 'GET',
      headers: {
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...options.headers,
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }),
    options.env ?? {},
    options.options ?? {},
  );
  return {
    status: response.status,
    body: options.method === 'HEAD' ? {} : await response.json(),
    ...selectedHeaders(options.responseHeaders, (name) =>
      name.toLowerCase() === 'set-cookie'
        ? response.headers.getSetCookie()
        : response.headers.get(name),
    ),
  };
};

export const CATALOG_RUNTIMES: CatalogRuntimeName[] = ['node', 'serverless'];
export { MUSICU_URL };
