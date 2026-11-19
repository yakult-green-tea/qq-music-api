import type { AxiosRequestConfig, AxiosResponse } from 'axios';
import type { QqCredential, QrLoginService } from '../../src/services/auth/qrLogin';
import type { createContractUpstream } from './contractUpstream';

let mockUpstream: ReturnType<typeof createContractUpstream>;
let mockSessionService: QrLoginService;
let mockExecute: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

// 会话比对只替换执行器和 Node 的实例；所有 controller、服务、凭证映射都照真实路径运行。
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
        const response = await mockExecute(url, {
          method: String(outgoing.method ?? 'GET').toUpperCase(),
          body: outgoing.data === undefined ? undefined : String(outgoing.data),
        });
        if (!response.ok)
          throw Object.assign(new Error('Fixture HTTP failure'), {
            response: { status: response.status },
          });
        return {
          data: await response.json(),
          status: response.status,
          statusText: 'OK',
          headers: {},
          config: outgoing,
        } as AxiosResponse;
      },
    });
  return actual;
});
jest.mock('../../src/services/auth/qrLogin.node', () => ({
  __esModule: true,
  get default() {
    return mockSessionService;
  },
  get qrLoginService() {
    return mockSessionService;
  },
  configureAuthSessionRepository: (
    repository: Parameters<QrLoginService['configureAuthSessionRepository']>[0],
  ) => mockSessionService.configureAuthSessionRepository(repository),
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
import type { CatalogRuntimeName } from './catalogRoutes';
import {
  CONTRACT_CREDENTIAL,
  CONTRACT_NOW,
  CONTRACT_SECRET,
  createContractUpstream as makeUpstream,
} from './contractUpstream';
import type { ParityCallOptions } from './operationParity';

export interface SessionCall {
  endpoint: string;
  rpc: Array<{ module: string; method: string; param: Record<string, unknown> }>;
  params: Record<string, string>;
}
interface SessionReply {
  code?: number;
  data?: unknown;
  httpStatus?: number;
}

export const useSessionUpstream = (runtime: CatalogRuntimeName) => {
  const calls: SessionCall[] = [];
  const state: {
    businessCode?: number;
    globalCode?: number;
    data?: unknown;
    networkError?: Error;
    httpStatus?: number;
    anonymousPlaylist?: unknown;
    anonymousPlay?: unknown;
    /** 单曲详情按 songmid 回 `track_info`；没列到的歌回空的 data。 */
    songDetails?: Record<string, unknown>;
    detailBusinessCode?: number;
    detailNetworkError?: boolean;
    credentialLoginType?: number;
    credentialOverrides?: Partial<QqCredential>;
    playbackHintsEnabled?: boolean;
    /** 取链接的备援：两个宿主都默认关着，好让其他测试只看主路径；专门的测试打开。 */
    playbackFallbackEnabled?: boolean;
    rpcReplies?: Record<string, SessionReply>;
    rpcReplyQueues?: Record<string, SessionReply[]>;
    /** 旧 CGI 的假回应：回传 undefined 就照原来的契约桩处理；有 httpStatus 时回那个状态。 */
    cgiReply?: (url: URL) => { body?: unknown; httpStatus?: number } | undefined;
  } = {};

  const sessionOf = (expiresAt = CONTRACT_NOW + 3600000) => ({
    token: 'a'.repeat(64),
    credential: {
      ...CONTRACT_CREDENTIAL,
      ...(state.credentialLoginType === undefined ? {} : { loginType: state.credentialLoginType }),
      ...state.credentialOverrides,
    },
    device: deviceFixture.device,
    expiresAt,
  });

  const resetService = (expiresAt: number) => {
    const session = sessionOf(expiresAt);
    mockSessionService = createQrLoginService({
      ...{ playbackHintsEnabled: state.playbackHintsEnabled },
      playbackFallbackEnabled: state.playbackFallbackEnabled === true,
      http: createAuthHttpClient(),
      createSessionHttp: createAuthHttpClient,
      deviceRepository: createMemoryDeviceContextRepository(deviceFixture.device),
      ...(runtime === 'node'
        ? { authSessionRepository: createMemoryAuthSessionRepository([session]) }
        : {
            sessionResolver: createSealedSessionResolver({ secrets: { current: CONTRACT_SECRET } }),
          }),
    });
  };

  beforeEach(() => {
    calls.length = 0;
    for (const key of Object.keys(state)) delete state[key as keyof typeof state];
    jest.spyOn(Date, 'now').mockReturnValue(CONTRACT_NOW);
    jest.spyOn(logger, 'error').mockImplementation(() => undefined);
    mockUpstream = makeUpstream();
    mockExecute = async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const musicu = url.pathname === '/cgi-bin/musicu.fcg';
      const payload: Record<string, unknown> = musicu
        ? JSON.parse(url.searchParams.get('data') ?? (await request.clone().text()))
        : {};
      const descriptors = Object.entries(payload)
        .filter(([key, value]) => key !== 'comm' && typeof value === 'object' && value !== null)
        .map(
          ([key, value]) =>
            [
              key,
              value as { module: string; method: string; param: Record<string, unknown> },
            ] as const,
        );
      calls.push({
        endpoint: url.pathname,
        rpc: descriptors.map(([, value]) => value),
        params: Object.fromEntries([...url.searchParams].filter(([key]) => key !== 'data')),
      });
      if (url.pathname.includes('fcg_ucc_getcdinfo_byids') && state.anonymousPlaylist !== undefined)
        return Response.json(state.anonymousPlaylist);
      const cgi = musicu ? undefined : state.cgiReply?.(url);
      if (cgi)
        return cgi.httpStatus
          ? new Response('fixture-private-body', { status: cgi.httpStatus })
          : Response.json(cgi.body);
      if (state.networkError) throw state.networkError;
      if (state.httpStatus)
        return new Response('fixture-private-body', { status: state.httpStatus });
      if (
        descriptors.some(
          ([, rpc]) => state.rpcReplies?.[rpc.method] || state.rpcReplyQueues?.[rpc.method]?.length,
        )
      ) {
        const method = descriptors[0][1].method;
        const reply = state.rpcReplyQueues?.[method]?.shift() ?? state.rpcReplies?.[method];
        if (reply?.httpStatus)
          return new Response('fixture-private-body', { status: reply.httpStatus });
        return Response.json({
          code: state.globalCode ?? 0,
          ...Object.fromEntries(
            descriptors.map(([key, rpc]) => [
              key,
              {
                code:
                  rpc.method === method
                    ? (reply?.code ?? 0)
                    : (state.rpcReplies?.[rpc.method]?.code ?? 0),
                data:
                  rpc.method === method
                    ? (reply?.data ?? {})
                    : (state.rpcReplies?.[rpc.method]?.data ?? {}),
              },
            ]),
          ),
        });
      }
      const detail = descriptors.find(([, value]) => value.method === 'get_song_detail_yqq');
      if (detail && state.detailNetworkError) throw new Error('fixture-detail-failure');
      if (detail && state.songDetails) {
        const trackInfo = state.songDetails[String(detail[1].param.song_mid)];
        return Response.json({
          code: 0,
          [detail[0]]: {
            code: state.detailBusinessCode ?? 0,
            data: trackInfo === undefined ? {} : { track_info: trackInfo },
          },
        });
      }
      if (descriptors.some(([, value]) => value.method === 'CgiGetVkey'))
        return Response.json(
          state.anonymousPlay ?? {
            code: 0,
            req_0: {
              code: 0,
              data: {
                sip: ['http://ws.fixture.invalid/', 'https://stream.invalid/'],
                midurlinfo: (descriptors[0][1].param.songmid as string[]).map((songmid) => ({
                  songmid,
                  purl: 'fixture.mp3',
                })),
              },
            },
          },
        );
      const response = descriptors.some(([, value]) => value.method === 'SRFVipQuery_V2')
        ? Response.json({
            code: 0,
            ...Object.fromEntries(descriptors.map(([key]) => [key, { code: 0, data: {} }])),
          })
        : descriptors.some(([, value]) => value.method === 'uniform_get_Dissinfo')
          ? Response.json({
              code: 0,
              req_0: {
                code: 0,
                data: {
                  dirinfo: { id: 70001, title: 'Fixture playlist', songnum: 1 },
                  songlist: [{ mid: 'fixture-song', title: 'Fixture song' }],
                  total_song_num: 1,
                  hasmore: 0,
                },
              },
            })
          : await mockUpstream.fetch(request);
      if (!musicu && !url.pathname.includes('fcg_get_profile_order_asset')) return response;
      const body = (await response.json()) as Record<string, unknown>;
      if (state.globalCode !== undefined) body.code = state.globalCode;
      if (musicu) {
        for (const [key] of descriptors) {
          const entry = body[key] as Record<string, unknown>;
          if (state.businessCode !== undefined) entry.code = state.businessCode;
          if (state.data !== undefined) entry.data = state.data;
        }
      } else {
        if (state.businessCode !== undefined) body.code = state.businessCode;
        if (state.data !== undefined) body.data = state.data;
      }
      return Response.json(body);
    };
    jest.spyOn(global, 'fetch').mockImplementation((input, init) => mockExecute(input, init));
    resetService(CONTRACT_NOW + 3600000);
  });
  afterEach(() => jest.restoreAllMocks());

  return {
    calls,
    state,
    options: async (
      mode: 'valid' | 'missing' | 'invalid' | 'expired' = 'valid',
    ): Promise<ParityCallOptions> => {
      const expiresAt = mode === 'expired' ? CONTRACT_NOW - 1 : CONTRACT_NOW + 3600000;
      const session = sessionOf(expiresAt);
      const token =
        mode === 'missing'
          ? undefined
          : mode === 'invalid'
            ? 'fixture-invalid-token'
            : runtime === 'node'
              ? session.token
              : await createSealedSessionResolver({ secrets: { current: CONTRACT_SECRET } }).issue(
                  session,
                );
      return {
        token,
        env: {
          QQ_SESSION_SECRET: CONTRACT_SECRET,
          ...{ QQ_PLAYBACK_HINTS_ENABLED: state.playbackHintsEnabled === false ? '0' : undefined },
          QQ_PLAYBACK_FALLBACK_ENABLED: state.playbackFallbackEnabled === true ? undefined : '0',
        },
        service: async () => mockSessionService,
        beforeEachLeg: () => resetService(expiresAt),
      };
    },
  };
};
