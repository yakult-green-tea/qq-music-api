import type { AxiosRequestConfig, AxiosResponse } from 'axios';
import type { QqCredential, QrLoginService } from '../../src/services/auth/qrLogin';

/**
 * 把两种宿主实际送给上游的请求完整录下来：地址、查询参数、协议相关的标头（User-Agent、Cookie、
 * Referer、Content-Type、Host、Range）和请求体。Node 的认证与旧曲库请求走 axios，其他走 fetch，
 * 这里两条都接住，录成同一种形状。所有回应都是合成的，不出网。
 */

export interface WireRequest {
  method: string;
  url: URL;
  /** 标头名一律小写。 */
  headers: Record<string, string>;
  body: string;
}

export interface WireReply {
  status?: number;
  json?: unknown;
  /** 回一段指定长度的二进制内容，给探测播放地址的请求用。 */
  bytes?: number;
}

let mockWireExecute: (request: WireRequest) => Promise<WireReply> | WireReply = () => ({});
let mockWireService: QrLoginService;

jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  const create = actual.default.create.bind(actual.default);
  actual.default.create = (config: AxiosRequestConfig) =>
    create({
      ...config,
      adapter: async (outgoing: AxiosRequestConfig): Promise<AxiosResponse> => {
        const url = new URL(String(outgoing.url));
        for (const [key, value] of Object.entries(outgoing.params ?? {}))
          if (value != null) url.searchParams.set(key, String(value));
        const source =
          (
            outgoing.headers as { toJSON?: () => Record<string, unknown> } | undefined
          )?.toJSON?.() ??
          (outgoing.headers as Record<string, unknown> | undefined) ??
          {};
        const headers: Record<string, string> = {};
        for (const [name, value] of Object.entries(source))
          if (typeof value === 'string') headers[name.toLowerCase()] = value;
        const reply = await mockWireExecute({
          method: String(outgoing.method ?? 'GET').toUpperCase(),
          url,
          headers,
          body: outgoing.data === undefined ? '' : String(outgoing.data),
        });
        const status = reply.status ?? 200;
        const response = {
          data: reply.bytes === undefined ? reply.json : new ArrayBuffer(reply.bytes),
          status,
          statusText: '',
          headers: {},
          config: outgoing,
        } as AxiosResponse;
        const accepted = outgoing.validateStatus
          ? outgoing.validateStatus(status)
          : status >= 200 && status < 300;
        if (!accepted) throw Object.assign(new Error('Fixture HTTP failure'), { response });
        return response;
      },
    });
  return actual;
});
jest.mock('../../src/services/auth/qrLogin.node', () => ({
  __esModule: true,
  get default() {
    return mockWireService;
  },
  get qrLoginService() {
    return mockWireService;
  },
  configureAuthSessionRepository: (
    repository: Parameters<QrLoginService['configureAuthSessionRepository']>[0],
  ) => mockWireService.configureAuthSessionRepository(repository),
}));

import { createSealedSessionResolver } from '../../src/serverless/sealedResolver';
import { createMemoryDeviceContextRepository } from '../../src/services/auth/deviceContext';
import createAuthHttpClient from '../../src/services/auth/httpClient';
import {
  createMemoryAuthSessionRepository,
  createQrLoginService,
} from '../../src/services/auth/qrLogin';
import { logger } from '../../src/util/logger';
import deviceFixture from '../fixtures/contracts/device-v1.json';
import { type CatalogRuntimeName, callRoute, type RouteCallOptions } from './catalogRoutes';
import { CONTRACT_NOW, CONTRACT_SECRET } from './contractUpstream';

export const WIRE_DEVICE = deviceFixture.device;
const STORED_TOKEN = 'a'.repeat(64);
const KEPT_HEADERS = ['content-type', 'cookie', 'host', 'range', 'referer', 'user-agent'];

export interface RecordedCall {
  method: string;
  url: string;
  query?: Record<string, string>;
  headers: Record<string, string>;
  /** 请求体（或查询参数 `data`）是 JSON 时解析后的内容。 */
  json?: unknown;
  /** 不是 JSON 的请求体原样留着。 */
  text?: string;
}

const parse = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

export const recordedCallOf = (request: WireRequest): RecordedCall => {
  const data = request.url.searchParams.get('data');
  const text = data ?? request.body;
  const json = text ? parse(text) : undefined;
  const query = Object.fromEntries(
    [...request.url.searchParams]
      .filter(([key]) => !(data !== null && json !== undefined && key === 'data'))
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
  );
  return {
    method: request.method,
    url: `${request.url.origin}${request.url.pathname}`,
    ...(Object.keys(query).length ? { query } : {}),
    headers: Object.fromEntries(
      KEPT_HEADERS.filter((name) => request.headers[name] !== undefined).map((name) => [
        name,
        request.headers[name],
      ]),
    ),
    ...(json !== undefined ? { json } : text ? { text } : {}),
  };
};

type RpcData = Record<string, unknown>;
export interface WireScript {
  /** 按上游方法名给 `data`；给数组时依次用，用完后一直用最后一个。 */
  rpc?: Record<string, RpcData | RpcData[]>;
  /** 探测播放地址时各主机回的状态，没列到的回 206。 */
  streams?: Record<string, number>;
  /** musicu 以外的请求回的 JSON，默认是 `{ code: 0 }`。 */
  cgi?: unknown;
  /** 打开取链接的备援（两个宿主一致）；不给时关着，其他情境只录主路径。 */
  fallback?: boolean;
}

const replier = (script: WireScript) => {
  const queues = new Map<string, RpcData[]>();
  const dataOf = (method: string): RpcData => {
    const configured = script.rpc?.[method];
    if (!Array.isArray(configured)) return configured ?? {};
    const queue = queues.get(method) ?? [...configured];
    queues.set(method, queue);
    return (queue.length > 1 ? queue.shift() : queue[0]) ?? {};
  };
  return (request: WireRequest): WireReply => {
    if (request.headers.range !== undefined)
      return { status: script.streams?.[request.url.hostname] ?? 206, bytes: 1024 };
    if (!request.url.pathname.endsWith('/musicu.fcg')) return { json: script.cgi ?? { code: 0 } };
    const payload = parse(request.url.searchParams.get('data') ?? request.body);
    const body: Record<string, unknown> = { code: 0 };
    for (const [key, value] of Object.entries((payload ?? {}) as Record<string, unknown>)) {
      const method = (value as { method?: unknown } | null)?.method;
      if (key !== 'comm' && typeof method === 'string')
        body[key] = { code: 0, data: dataOf(method) };
    }
    return { json: body };
  };
};

export interface WireRun {
  status: number;
  body: unknown;
  calls: RecordedCall[];
}

/**
 * 在真实宿主上跑一条路由（Node 是 Koa 应用，Serverless 是 `handleRequest`），回状态、回包和按顺序录下的上游请求。
 * 给 `credential` 就带这个账号的会话：Node 用存在服务里的会话，Serverless 用封在 token 里的会话。
 */
export const runOnWire = async (
  runtime: CatalogRuntimeName,
  path: string,
  script: WireScript = {},
  credential?: QqCredential,
  request: Pick<RouteCallOptions, 'method' | 'body'> = {},
): Promise<WireRun> => {
  const calls: RecordedCall[] = [];
  const reply = replier(script);
  mockWireExecute = (wire) => {
    calls.push(recordedCallOf(wire));
    return reply(wire);
  };
  const session = credential && {
    token: STORED_TOKEN,
    credential,
    device: { ...WIRE_DEVICE },
    expiresAt: CONTRACT_NOW + 3600000,
  };
  mockWireService = createQrLoginService({
    playbackFallbackEnabled: script.fallback === true,
    http: createAuthHttpClient(),
    createSessionHttp: createAuthHttpClient,
    deviceRepository: createMemoryDeviceContextRepository({ ...WIRE_DEVICE }),
    authSessionRepository: createMemoryAuthSessionRepository(session ? [session] : []),
  });
  const token = !session
    ? undefined
    : runtime === 'node'
      ? session.token
      : await createSealedSessionResolver({ secrets: { current: CONTRACT_SECRET } }).issue(session);
  const result = await callRoute(runtime, path, {
    ...request,
    headers: token === undefined ? {} : { 'X-QQ-Session': token },
    env: {
      QQ_SESSION_SECRET: CONTRACT_SECRET,
      QQ_PLAYBACK_FALLBACK_ENABLED: script.fallback === true ? undefined : '0',
    },
  });
  return { status: result.status, body: result.body, calls };
};

/** 在 `describe` 里调用：固定时间与随机值，并把 fetch 接到录制器上。 */
export const useWireRecorder = () => {
  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(CONTRACT_NOW);
    for (const level of ['error', 'warn', 'info', 'debug'] as const)
      jest.spyOn(logger, level).mockImplementation(() => undefined);
    jest.spyOn(Math, 'random').mockReturnValue(0.5);
    jest
      .spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValue('00000000-0000-4000-8000-000000000001');
    jest.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
      const source = input instanceof Request ? input : undefined;
      const headers: Record<string, string> = {};
      new Headers(source ? source.headers : init?.headers).forEach((value, name) => {
        headers[name.toLowerCase()] = value;
      });
      const reply = await mockWireExecute({
        method: String(source?.method ?? init?.method ?? 'GET').toUpperCase(),
        url: new URL(source ? source.url : String(input)),
        headers,
        body: source
          ? await source.clone().text()
          : typeof init?.body === 'string'
            ? init.body
            : '',
      });
      if (reply.bytes !== undefined)
        return new Response(new ArrayBuffer(reply.bytes), { status: reply.status ?? 206 });
      return new Response(JSON.stringify(reply.json ?? {}), {
        status: reply.status ?? 200,
        headers: { 'content-type': 'application/json' },
      });
    });
  });
  afterEach(() => jest.restoreAllMocks());
};
