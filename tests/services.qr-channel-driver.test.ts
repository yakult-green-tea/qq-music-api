import type { AxiosRequestConfig, AxiosResponse } from 'axios';
import type { AuthHttpClient } from '../src/services/auth/httpClient';
import {
  createQrLoginService,
  type QrChannelDriver,
  type QrEvent,
  type QrEventListener,
  type QrSessionRecord,
} from '../src/services/auth/qrLogin';

const QIMEI_16 = 'q'.repeat(36);
const QIMEI_36 = 'r'.repeat(36);

const response = <T>(data: T): AxiosResponse<T> =>
  ({
    data,
    status: 200,
    statusText: 'OK',
    headers: {},
    config: { headers: {} },
  }) as AxiosResponse<T>;

const dictionaryOf = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};

/** Answers only the two calls `createSession()` makes before a QR exists. */
const createBootstrapHttp = (): AuthHttpClient =>
  ({
    getCookieHeader: () => '',
    request: jest.fn(),
    post: jest.fn(async (_url: string, payload?: unknown) => {
      if (!dictionaryOf(payload).req_0) {
        return response({
          data: JSON.stringify({ code: 0, data: { q16: QIMEI_16, q36: QIMEI_36 } }),
        });
      }
      return response({
        code: 0,
        req_0: { code: 0, data: { session: { uid: 1234567890, sid: 'session-sid' } } },
      });
    }),
  }) as unknown as AuthHttpClient;

interface PullDriverStub {
  driver: QrChannelDriver;
  budgets: number[];
  queue: Array<QrEvent[] | Error>;
}

const createPullDriverStub = (): PullDriverStub => {
  const budgets: number[] = [];
  const queue: Array<QrEvent[] | Error> = [];
  return {
    budgets,
    queue,
    driver: {
      mode: 'pull',
      createQr: async () => ({ identifier: 'pull-uuid', imageUrl: 'data:image/png;base64,AA' }),
      advance: async (_session, budgetMs) => {
        budgets.push(budgetMs);
        const next = queue.shift();
        if (next instanceof Error) throw next;
        return next ?? [];
      },
      close: () => undefined,
    },
  };
};

interface PushDriverStub {
  driver: QrChannelDriver;
  advances: number;
  closed: boolean;
  emit(event: QrEvent): void;
}

const createPushDriverStub = (): PushDriverStub => {
  const stub: PushDriverStub = {
    advances: 0,
    closed: false,
    emit: () => {
      throw new Error('listener not started');
    },
    driver: {
      mode: 'push',
      createQr: async () => ({ identifier: 'push-id', imageUrl: 'data:image/png;base64,BB' }),
      start: (_session: QrSessionRecord, context): QrEventListener => {
        stub.emit = context.onEvent;
        context.onEvent({ type: 'waiting', payload: null });
        return {
          ready: Promise.resolve(),
          done: new Promise<void>(() => undefined),
          close: () => {
            stub.closed = true;
          },
        };
      },
      advance: async () => {
        stub.advances += 1;
        return [];
      },
      close: () => {
        stub.closed = true;
      },
    },
  };
  return stub;
};

const startSession = async (
  channel: 'qq' | 'wechat',
  driver: QrChannelDriver,
  checkBudgetMs?: number,
) => {
  const service = createQrLoginService({
    http: createBootstrapHttp(),
    drivers: { [channel]: driver },
    checkBudgetMs,
    randomBytes: (size) => Buffer.alloc(size, 7),
  });
  const key = await service.createSession(channel);
  await service.createQr(key);
  return { service, key };
};

describe('QR channel drivers', () => {
  it('should observe a pull channel exactly once per check and never between checks', async () => {
    const pull = createPullDriverStub();
    const { service, key } = await startSession('wechat', pull.driver);

    expect(pull.budgets).toHaveLength(0);
    await expect(service.checkQr(key)).resolves.toMatchObject({ code: 801 });
    expect(pull.budgets).toHaveLength(1);

    // Nothing runs between checks: a closed dialog stops polling instead of holding a loop open
    // for the rest of the QR's life.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(pull.budgets).toHaveLength(1);

    await service.checkQr(key);
    expect(pull.budgets).toHaveLength(2);
  });

  it('should pass the configured budget to a pull driver and let a caller override it', async () => {
    const pull = createPullDriverStub();
    const { service, key } = await startSession('wechat', pull.driver, 2500);

    await service.checkQr(key);
    await service.checkQr(key, 9000);

    expect(pull.budgets).toEqual([2500, 9000]);
  });

  it('should keep waiting while a pull driver reports no change', async () => {
    const pull = createPullDriverStub();
    const { service, key } = await startSession('wechat', pull.driver);

    // An elapsed long-poll budget is "nothing happened", not a failure.
    pull.queue.push([]);

    await expect(service.checkQr(key)).resolves.toMatchObject({
      code: 801,
      message: 'Waiting for QR scan',
    });
  });

  it('should tolerate a run of pull failures before failing the session', async () => {
    const pull = createPullDriverStub();
    const { service, key } = await startSession('wechat', pull.driver);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      pull.queue.push(new Error('dropped long poll'));
      await expect(service.checkQr(key)).resolves.toMatchObject({ code: 801 });
    }

    pull.queue.push(new Error('dropped long poll'));
    const failed = await service.checkQr(key);

    expect(failed.code).toBe(800);
    expect(failed.message).toBe('QR login failed');
    expect(failed.retryAfterMs).toBeGreaterThan(0);
  });

  it('should move a pull channel through scanned to confirmed', async () => {
    const pull = createPullDriverStub();
    const { service, key } = await startSession('wechat', pull.driver);

    pull.queue.push([{ type: 'scanned', payload: null }]);
    await expect(service.checkQr(key)).resolves.toMatchObject({ code: 802 });

    pull.queue.push([{ type: 'timeout', payload: null }]);
    await expect(service.checkQr(key)).resolves.toMatchObject({ code: 800 });
  });

  it('should never poll a push channel and should drive it from its listener', async () => {
    const push = createPushDriverStub();
    const { service, key } = await startSession('qq', push.driver);

    await expect(service.checkQr(key)).resolves.toMatchObject({ code: 801 });
    expect(push.advances).toBe(0);

    push.emit({ type: 'scanned', payload: null });
    await expect(service.checkQr(key)).resolves.toMatchObject({ code: 802 });
    expect(push.advances).toBe(0);
  });

  it('should back off an expired scannable code but not an abandoned key', async () => {
    let current = 1_000_000;
    const now = () => current;
    const build = async (channel: 'wechat', driver: QrChannelDriver, createCode: boolean) => {
      const service = createQrLoginService({
        http: createBootstrapHttp(),
        drivers: { [channel]: driver },
        now,
        randomBytes: (size) => Buffer.alloc(size, 7),
      });
      const key = await service.createSession(channel);
      if (createCode) await service.createQr(key);
      return service;
    };

    // A key issued and abandoned before `createQr` never had anything to scan, and the
    // pre-driver implementation never started a listener for it either.
    const abandoned = await build('wechat', createPullDriverStub().driver, false);
    current += 3 * 60 * 1000 + 1;
    await expect(abandoned.createSession('wechat')).resolves.toEqual(expect.any(String));

    // A code that was displayed and then left to expire keeps counting as a failure, which is
    // what the App channel's `timeout` event has always done.
    current = 1_000_000;
    const expired = await build('wechat', createPullDriverStub().driver, true);
    current += 3 * 60 * 1000 + 1;
    const error = await expired.createSession('wechat').catch((reason: unknown) => reason);

    expect(error).toEqual(expect.objectContaining({ httpStatus: 429 }));
  });

  it('should close a push listener when the session is cancelled', async () => {
    const push = createPushDriverStub();
    const { service, key } = await startSession('qq', push.driver);

    expect(push.closed).toBe(false);
    service.cancelSession(key);

    expect(push.closed).toBe(true);
    await expect(service.checkQr(key)).resolves.toMatchObject({ code: 800 });
  });
});

describe('WeChat pull driver long-poll semantics', () => {
  const createWechatHttp = (onPoll: () => Promise<AxiosResponse<string>>): AuthHttpClient =>
    ({
      getCookieHeader: () => '',
      request: jest.fn(async (config: AxiosRequestConfig) => {
        const url = String(config.url);
        if (url === 'https://open.weixin.qq.com/connect/qrconnect') {
          return response(
            '<a href="https://open.weixin.qq.com/connect/confirm?uuid=wx-uuid">x</a>',
          );
        }
        if (url.includes('/connect/qrcode/'))
          return response(Buffer.from('89504e470d0a1a0a01020304', 'hex'));
        if (url.includes('/l/qrconnect')) return onPoll();
        throw new Error(`Unexpected WeChat URL: ${url}`);
      }),
      post: jest.fn(),
    }) as unknown as AuthHttpClient;

  it('should report an elapsed poll budget as "still waiting"', async () => {
    let polls = 0;
    const service = createQrLoginService({
      http: createBootstrapHttp(),
      createSessionHttp: () =>
        createWechatHttp(async () => {
          polls += 1;
          // What `AbortSignal.timeout` produces once the budget elapses.
          const aborted = new Error('timeout');
          aborted.name = 'TimeoutError';
          throw aborted;
        }),
      randomBytes: (size) => Buffer.alloc(size, 7),
    });
    const key = await service.createSession('wechat');
    await service.createQr(key);

    await expect(service.checkQr(key)).resolves.toMatchObject({ code: 801 });
    await expect(service.checkQr(key)).resolves.toMatchObject({ code: 801 });
    expect(polls).toBe(2);
  });
});
