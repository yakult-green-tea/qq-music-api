import { withBoundedPlaybackHttp } from '../src/services/auth/playbackFallback';
import type { AuthHttpClient, HttpRequestConfig } from '../src/transport/httpClientTypes';

describe('加密取链接的请求预算', () => {
  afterEach(() => jest.useRealTimers());

  it('超过次数时停止，已发送的请求共享同一个信号且不跟随转址', async () => {
    const send = jest.fn().mockResolvedValue({ data: {} });
    const http: AuthHttpClient = {
      getCookieHeader: () => '',
      request: send,
      post: (_url, _body, config) => send(config),
    };
    await expect(
      withBoundedPlaybackHttp(
        http,
        async (client) => {
          await client.post('https://fixture.invalid');
          await client.request({ url: 'https://fixture.invalid' });
          await client.post('https://fixture.invalid');
        },
        { maxRequests: 2, timeoutMs: 100 },
      ),
    ).rejects.toMatchObject({ kind: 'rate-limited' });
    expect(send).toHaveBeenCalledTimes(2);
    const [first, second] = send.mock.calls.map(([config]) => config);
    expect(first).toMatchObject({ followRedirects: false, signal: expect.any(AbortSignal) });
    expect(second.signal).toBe(first.signal);
  });

  it('截止时终止上游请求并返回稳定的超时码', async () => {
    jest.useFakeTimers();
    const send = jest.fn(
      (config: HttpRequestConfig) =>
        new Promise<never>((_resolve, reject) => {
          config.signal?.addEventListener('abort', () => reject(new Error('fixture-private')), {
            once: true,
          });
        }),
    );
    const http: AuthHttpClient = {
      getCookieHeader: () => '',
      request: send,
      post: (_url, _body, config = {}) => send(config),
    };
    const operation = withBoundedPlaybackHttp(
      http,
      (client) => client.post('https://fixture.invalid'),
      {
        maxRequests: 2,
        timeoutMs: 25,
      },
    );
    const timeout = expect(operation).rejects.toMatchObject({
      kind: 'network',
      errorKey: 'network.timeout',
    });
    await jest.advanceTimersByTimeAsync(25);
    await timeout;
    expect(send.mock.calls[0]?.[0].signal?.aborted).toBe(true);
  });
});
