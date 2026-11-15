import { getEncryptedMusicPlay } from '../src/routes/operations/getEncryptedMusicPlay';
import type { OperationRequest } from '../src/routes/operations/types';
import { createMemoryAuthSessionRepository, createQrLoginService } from '../src/services/auth/qrLogin';
import type { AuthHttpClient } from '../src/transport/httpClientTypes';
import { logger } from '../src/util/logger';
import deviceFixture from './fixtures/contracts/device-v1.json';
import { CONTRACT_CREDENTIAL, CONTRACT_NOW } from './helpers/contractUpstream';

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
      runtime, method: 'GET', params: {}, token, signal,
      query: (key) => key === 'songmid' ? 'FixtureSong001' : key === 'quality' ? quality : undefined,
      queryRaw: (key) => key === 'songmid' ? 'FixtureSong001' : key === 'quality' ? quality : undefined,
      service: async () => service,
    };
    return getEncryptedMusicPlay(req);
  };
  beforeEach(() => {
    send.mockReset().mockRejectedValue(new Error('fixture failure'));
    jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const session = {
      token: 'valid-fixture', device: deviceFixture.device, expiresAt: CONTRACT_NOW + 3600000,
      credential: { ...CONTRACT_CREDENTIAL, refresh_key: 'fixture-secret', musickeyCreateTime: CONTRACT_NOW / 1000, keyExpiresIn: 3600 },
    };
    service = createQrLoginService({ http, now: () => CONTRACT_NOW, authSessionRepository: createMemoryAuthSessionRepository([session]) });
  });
  afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });

  it('参数错误不触发会话更新或其他上游请求', async () => {
    const result = await call('valid-fixture', '320');
    expect(result.status).toBe(400);
    expect(send).toHaveBeenCalledTimes(0);
  });

  it.each([undefined, 'invalid-fixture'])('无效会话优先于参数错误', async (token) => {
    const result = await call(token, '320');
    expect(result.status).toBe(401);
    expect(send).toHaveBeenCalledTimes(0);
  });

  const response = (data: unknown) => ({ status: 200, statusText: 'OK', headers: {}, data: { code: 0, req_0: { code: 0, data } } });
  const replyFor = (method: string) => method === 'get_song_detail_yqq'
    ? { track_info: { mid: 'FixtureSong001', file: { media_mid: 'MediaFixtureA1' } } }
    : { midurlinfo: [{ songmid: 'FixtureSong001', purl: 'O6M0MediaFixtureA1.mgg?fixture', result: 0, ekey: 'fixture-key' }] };
  const methodOf = (config: any): string => config.data.req_0.method;
  const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

  it('更新和取链接共用十五秒，更新请求不跟随转址', async () => {
    jest.useFakeTimers({ now: CONTRACT_NOW });
    send.mockImplementation((config) => {
      if (methodOf(config) === 'Login') return new Promise((resolve) => setTimeout(() => resolve(response(CONTRACT_CREDENTIAL)), 10_000));
      return new Promise((_resolve, reject) => config.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
    });
    const pending = call('valid-fixture', '192');
    await flush();
    expect(send.mock.calls[0][0].followRedirects).toBe(false);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(send).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(5_000);
    const result = await pending;
    expect(result.status).toBe(502);
    expect(result.body).toMatchObject({ errorKey: 'network.timeout' });
    expect(send.mock.calls[1][0].signal.aborted).toBe(true);
  });

  it('调用端取消时终止等待且不再发请求', async () => {
    send.mockImplementation((config) => new Promise((_resolve, reject) => config.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })));
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

  it('共享更新时一方取消不打断另一方', async () => {
    let complete: (value: unknown) => void = () => {};
    send.mockImplementation((config) => methodOf(config) === 'Login'
      ? new Promise((resolve) => { complete = resolve; })
      : Promise.resolve(response(replyFor(methodOf(config)))));
    const cancel = new AbortController();
    const first = call('valid-fixture', '192', cancel.signal);
    const second = call('valid-fixture', '192');
    await flush();
    expect(send).toHaveBeenCalledTimes(1);
    cancel.abort();
    expect((await first).body).toMatchObject({ errorKey: 'network.aborted' });
    expect(send.mock.calls[0][0].signal.aborted).toBe(false);
    complete(response(CONTRACT_CREDENTIAL));
    const result = await second;
    expect(result.status).toBe(200);
    expect(send.mock.calls.map(([config]) => methodOf(config))).toEqual(['Login', 'get_song_detail_yqq', 'CgiGetEVkey']);
  });

  it('所有等待者取消后，下一次请求仍可更新会话', async () => {
    send.mockImplementationOnce((config) => new Promise((_resolve, reject) => config.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })));
    send.mockImplementation((config) => Promise.resolve(response(methodOf(config) === 'Login' ? CONTRACT_CREDENTIAL : replyFor(methodOf(config)))));
    const cancel = new AbortController();
    const first = call('valid-fixture', '192', cancel.signal);
    await flush();
    cancel.abort();
    await first;
    await flush();
    const second = await call('valid-fixture', '192');
    expect(second.status).toBe(200);
    expect(send.mock.calls.map(([config]) => methodOf(config))).toEqual(['Login', 'Login', 'get_song_detail_yqq', 'CgiGetEVkey']);
  });
});
