import { getEncryptedMusicPlay } from '../src/routes/operations/getEncryptedMusicPlay';
import { operationController } from '../src/controllers/operation';
import { operationRoute } from '../src/serverless/operationRoute';
import { createSealedSessionResolver } from '../src/serverless/sealedResolver';
import { EventEmitter } from 'node:events';
import type { OperationRequest } from '../src/routes/operations/types';
import {
  createMemoryAuthSessionRepository,
  createQrLoginService,
} from '../src/services/auth/qrLogin';
import type { AuthHttpClient } from '../src/transport/httpClientTypes';
import { logger } from '../src/util/logger';
import deviceFixture from './fixtures/contracts/device-v1.json';
import { CONTRACT_CREDENTIAL, CONTRACT_NOW, CONTRACT_SECRET } from './helpers/contractUpstream';

describe.each(['node', 'serverless'] as const)('加密播放整次预算（%s）', (runtime) => {
  const send = jest.fn();
  const http: AuthHttpClient = {
    getCookieHeader: () => '',
    request: send,
    post: (_url, data, config) => send({ ...config, data }),
  };
  let service: ReturnType<typeof createQrLoginService>;
  const call = (token: string | undefined, quality: string, signal?: AbortSignal) => {
    const req: OperationRequest = {
      runtime,
      method: 'GET',
      params: {},
      token,
      signal,
      query: (key) =>
        key === 'songmid' ? 'FixtureSong001' : key === 'quality' ? quality : undefined,
      queryRaw: (key) =>
        key === 'songmid' ? 'FixtureSong001' : key === 'quality' ? quality : undefined,
      service: async () => service,
    };
    return getEncryptedMusicPlay(req);
  };
  beforeEach(() => {
    send.mockReset().mockRejectedValue(new Error('fixture failure'));
    jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const session = {
      token: 'valid-fixture',
      device: deviceFixture.device,
      expiresAt: CONTRACT_NOW + 3600000,
      credential: {
        ...CONTRACT_CREDENTIAL,
        refresh_key: 'fixture-secret',
        musickeyCreateTime: CONTRACT_NOW / 1000,
        keyExpiresIn: 3600,
      },
    };
    service = createQrLoginService({
      http,
      now: () => CONTRACT_NOW,
      authSessionRepository: createMemoryAuthSessionRepository([
        session,
        { ...session, token: 'expired-fixture', expiresAt: CONTRACT_NOW - 1 },
      ]),
    });
  });
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('参数错误不触发会话更新或其他上游请求', async () => {
    const result = await call('valid-fixture', '320');
    expect(result.status).toBe(400);
    expect(send).toHaveBeenCalledTimes(0);
  });

  it.each([
    undefined,
    'invalid-fixture',
    'expired-fixture',
  ])('无效会话优先于参数错误', async (token) => {
    const result = await call(token, '320');
    expect(result.status).toBe(401);
    expect(send).toHaveBeenCalledTimes(0);
  });

  const response = (data: unknown) => ({
    status: 200,
    statusText: 'OK',
    headers: {},
    data: { code: 0, req_0: { code: 0, data } },
  });
  const replyFor = (method: string) =>
    method === 'get_song_detail_yqq'
      ? { track_info: { mid: 'FixtureSong001', file: { media_mid: 'MediaFixtureA1' } } }
      : {
          midurlinfo: [
            {
              songmid: 'FixtureSong001',
              purl: 'O6M0MediaFixtureA1.mgg?fixture',
              result: 0,
              ekey: 'fixture-key',
            },
          ],
        };
  const methodOf = (config: any): string => config.data.req_0.method;
  const flush = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };

  it('提前更新期间只用现有凭证取链接，不主动更新', async () => {
    send.mockImplementation((config) => Promise.resolve(response(replyFor(methodOf(config)))));
    const result = await call('valid-fixture', '192');
    expect(result.status).toBe(200);
    expect(send.mock.calls.map(([config]) => methodOf(config))).toEqual([
      'get_song_detail_yqq', 'CgiGetEVkey',
    ]);
    const usesOldCredential = send.mock.calls.every(([config]) =>
      String(config.headers?.Cookie ?? '').includes(CONTRACT_CREDENTIAL.musickey),
    );
    expect(usesOldCredential).toBe(true);
  });

  it('等待旧路由正在进行的更新，然后使用新凭证', async () => {
    const freshKey = 'fixture-fresh-credential';
    let finish: (value: unknown) => void = () => {};
    send.mockImplementation((config) => methodOf(config) === 'Login'
      ? new Promise((resolve) => { finish = resolve; })
      : Promise.resolve(response(replyFor(methodOf(config)))));
    const oldCall = service.resolveSession('valid-fixture');
    await flush();
    const encrypted = call('valid-fixture', '192');
    await flush();
    expect(send.mock.calls.map(([config]) => methodOf(config))).toEqual(['Login']);
    finish(response({ ...CONTRACT_CREDENTIAL, musickey: freshKey }));
    await oldCall;
    expect((await encrypted).status).toBe(200);
    const usesNewCredential = send.mock.calls.slice(1).every(([config]) => String(config.headers?.Cookie ?? '').includes(freshKey));
    expect(usesNewCredential).toBe(true);
    expect(send.mock.calls.map(([config]) => methodOf(config))).toEqual(['Login', 'get_song_detail_yqq', 'CgiGetEVkey']);
  });

  it.each(['取消', '超时'] as const)('等待旧路由更新时%s，不中止更新或丢弃新凭证', async (mode) => {
    jest.useFakeTimers({ now: CONTRACT_NOW });
    const freshKey = 'fixture-fresh-credential';
    let finish: (value: unknown) => void = () => {};
    send.mockImplementation((config) => methodOf(config) === 'Login'
      ? new Promise((resolve) => { finish = resolve; })
      : Promise.resolve(response(replyFor(methodOf(config)))));
    const oldCall = service.resolveSession('valid-fixture');
    await flush();
    const controller = new AbortController();
    const encrypted = call('valid-fixture', '192', controller.signal);
    await flush();
    if (mode === '取消') controller.abort();
    else await jest.advanceTimersByTimeAsync(15_000);
    const result = await encrypted;
    expect(result.body).toMatchObject({ errorKey: mode === '取消' ? 'network.aborted' : 'network.timeout' });
    expect(send.mock.calls.map(([config]) => methodOf(config))).toEqual(['Login']);
    expect(send.mock.calls[0][0].signal?.aborted ?? false).toBe(false);
    finish(response({ ...CONTRACT_CREDENTIAL, musickey: freshKey }));
    await oldCall;
    const stored = await service.lookupSession('valid-fixture');
    expect(stored?.credential.musickey === freshKey).toBe(true);
    expect(send.mock.calls.map(([config]) => methodOf(config))).toEqual(['Login']);
  });

  it('封存会话在提前更新期间也能正常取链接', async () => {
    const resolver = createSealedSessionResolver({ secrets: { current: CONTRACT_SECRET }, now: () => CONTRACT_NOW });
    const token = await resolver.issue({ device: deviceFixture.device, credential: { ...CONTRACT_CREDENTIAL, refresh_key: 'fixture-secret', musickeyCreateTime: CONTRACT_NOW / 1000, keyExpiresIn: 3600 }, expiresAt: CONTRACT_NOW + 3600000 });
    service = createQrLoginService({ http, sessionResolver: resolver, now: () => CONTRACT_NOW });
    send.mockImplementation((config) => Promise.resolve(response(replyFor(methodOf(config)))));
    expect((await call(token, '192')).status).toBe(200);
    expect(send.mock.calls.map(([config]) => methodOf(config))).toEqual(['get_song_detail_yqq', 'CgiGetEVkey']);
  });

  it('等待已有更新和取链接共用十五秒，取链接不跟随转址', async () => {
    jest.useFakeTimers({ now: CONTRACT_NOW });
    send.mockImplementation((config) => {
      if (methodOf(config) === 'Login')
        return new Promise((resolve) =>
          setTimeout(() => resolve(response(CONTRACT_CREDENTIAL)), 10_000),
        );
      return new Promise((_resolve, reject) =>
        config.signal.addEventListener('abort', () => reject(new Error('cancelled')), {
          once: true,
        }),
      );
    });
    const oldCall = service.resolveSession('valid-fixture');
    await flush();
    const pending = call('valid-fixture', '192');
    await flush();
    await jest.advanceTimersByTimeAsync(10_000);
    await oldCall;
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0].followRedirects).toBe(false);
    await jest.advanceTimersByTimeAsync(5_000);
    const result = await pending;
    expect(result.status).toBe(502);
    expect(result.body).toMatchObject({ errorKey: 'network.timeout' });
    expect(send.mock.calls[1][0].signal.aborted).toBe(true);
  });

  it('调用端取消时终止等待且不再发请求', async () => {
    send.mockImplementation(
      (config) =>
        new Promise((_resolve, reject) =>
          config.signal.addEventListener('abort', () => reject(new Error('cancelled')), {
            once: true,
          }),
        ),
    );
    const cancel = new AbortController();
    const pending = call('valid-fixture', '192', cancel.signal);
    await flush();
    expect(send).toHaveBeenCalledTimes(1);
    cancel.abort();
    const result = await pending;
    expect(result.body).toMatchObject({ errorKey: 'network.aborted' });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].signal.aborted).toBe(true);
  });

  it('多个加密请求等待旧更新时一方取消不打断另一方', async () => {
    let complete: (value: unknown) => void = () => {};
    send.mockImplementation((config) =>
      methodOf(config) === 'Login'
        ? new Promise((resolve) => {
            complete = resolve;
          })
        : Promise.resolve(response(replyFor(methodOf(config)))),
    );
    const cancel = new AbortController();
    const oldCall = service.resolveSession('valid-fixture');
    await flush();
    const first = call('valid-fixture', '192', cancel.signal);
    const second = call('valid-fixture', '192');
    await flush();
    expect(send).toHaveBeenCalledTimes(1);
    cancel.abort();
    expect((await first).body).toMatchObject({ errorKey: 'network.aborted' });
    expect(send.mock.calls[0][0].signal?.aborted ?? false).toBe(false);
    complete(response(CONTRACT_CREDENTIAL));
    await oldCall;
    const result = await second;
    expect(result.status).toBe(200);
    expect(send.mock.calls.map(([config]) => methodOf(config))).toEqual([
      'Login',
      'get_song_detail_yqq',
      'CgiGetEVkey',
    ]);
  });

  it('宿主转接在连接关闭时中止上游并停止后续请求', async () => {
    send.mockImplementation(
      (config) =>
        new Promise((_resolve, reject) =>
          config.signal.addEventListener('abort', () => reject(new Error('cancelled')), {
            once: true,
          }),
        ),
    );
    let abort: () => void;
    let pending: Promise<unknown>;
    if (runtime === 'node') {
      const res = Object.assign(new EventEmitter(), { writableFinished: false });
      const ctx = {
        res,
        method: 'GET',
        query: { songmid: 'FixtureSong001', quality: '192' },
        get: () => 'valid-fixture',
        set: () => {},
        params: {},
      };
      const handler = operationController(
        (request) => getEncryptedMusicPlay({ ...request, service: async () => service }),
        true,
      );
      pending = handler(ctx as any);
      abort = () => {
        res.emit('close');
      };
    } else {
      const controller = new AbortController();
      const request = new Request(
        'https://fixture.invalid/getEncryptedMusicPlay?songmid=FixtureSong001&quality=192',
        { signal: controller.signal },
      );
      pending = operationRoute(
        getEncryptedMusicPlay,
        true,
      )({
        request,
        url: new URL(request.url),
        params: {},
        token: 'valid-fixture',
        service: async () => service,
      });
      abort = () => controller.abort();
    }
    await flush();
    expect(send).toHaveBeenCalledTimes(1);
    abort();
    await pending;
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].signal.aborted).toBe(true);
  });
});
