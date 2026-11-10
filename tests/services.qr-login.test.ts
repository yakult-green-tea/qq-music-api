import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import {
  createAndroidDevice,
  createMemoryDeviceContextRepository,
  type DeviceContextRepository,
} from '../src/services/auth/deviceContext';
import { createFileAuthSessionRepository } from '../src/services/auth/fileAuthSessionRepository';
import createAuthHttpClient, { type AuthHttpClient } from '../src/services/auth/httpClient';
import {
  type AuthSessionRepository,
  createMemoryAuthSessionRepository,
  createMemoryQrSessionRepository,
  createMqttListenOver,
  createQrLoginService,
  type MqttConnect,
  QqProtocolError,
  type QrLoginChannel,
  type QrLoginService,
  QrLoginServiceError,
  type SessionResolver,
} from '../src/services/auth/qrLogin';
import type { StreamUrlProbe } from '../src/services/auth/streamCdnSelector';
import { AuthCredentialRejectedError } from '../src/util/authError';
import { logger } from '../src/util/logger';

interface TestQrEvent {
  type: string;
  payload: unknown;
}

const QIMEI_16 = 'q'.repeat(36);
const QIMEI_36 = 'r'.repeat(36);

const response = <T>(
  data: T,
  status = 200,
  headers: Record<string, unknown> = {},
): AxiosResponse<T> => ({
  data,
  status,
  statusText: 'OK',
  headers: headers as AxiosResponse<T>['headers'],
  config: { headers: {} } as AxiosResponse<T>['config'],
});

const dictionaryOf = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};

const methodOf = (payload: unknown): string =>
  String(dictionaryOf(dictionaryOf(payload).req_0).method ?? '');

const WX_UUID = 'wx-uuid-fixture';
const WX_CODE = 'wx-oauth-code';
const WX_PNG = Buffer.from('89504e470d0a1a0a01020304', 'hex');

const wxStatusBody = (errcode: number, code = ''): string =>
  `window.wx_errcode=${errcode};window.wx_code='${code}';`;

interface HarnessOptions {
  failCredential?: boolean;
  listenerFailure?: string;
  listenerReadyFailure?: string;
  sessionFailure?: unknown;
  qrFailure?: unknown;
  sessionResolver?: SessionResolver;
  mqttConnect?: MqttConnect;
  /** The exchanged WeChat key is rejected with safe code 1000 until refreshed. */
  wechatNeedsRefresh?: boolean;
  deviceRepository?: DeviceContextRepository;
  authSessionRepository?: AuthSessionRepository;
  now?: () => number;
  qimei?: () => AxiosResponse<unknown>;
  /** Reproduces the Android `UrlGetVkey` response, which carries `midurlinfo` but no `sip`. */
  emptyVkeySip?: boolean;
  dispatchSips?: string[];
  streamUrlProbe?: StreamUrlProbe;
  /**
   * Reproduces the measured `GetLoginUserInfo` shape: no account id at all, every account field
   * nested under `info`. The convenience fixture above is not what the real endpoint answers.
   */
  nestedProfileOnly?: boolean;
  /**
   * Reproduces the measured WeChat credential: `musicid` is a placeholder `0` and the real
   * account id only ever arrives in `str_musicid`.
   */
  placeholderMusicId?: boolean;
  /** Whole favourite-album collection; the CGI stub slices the requested `sin`..`ein` out of it. */
  favoriteAlbums?: Record<string, unknown>[];
  /** Non-zero makes the favourite-album CGI reject the call, the way it does without a cookie. */
  favoriteAlbumCode?: number;
  /** Whole raw CGI body, for replies that accept the call but answer in an unexpected shape. */
  favoriteAlbumBody?: unknown;
  /** Raw poll bodies served in order; the last one keeps repeating. */
  wechatStatuses?: string[];
  wechatQrPage?: string;
  wechatImage?: Buffer;
  /**
   * 用 QQ 音乐 App 扫码、App 登的是微信账号（实测回调的 tmeLoginType 是 1）。照官方客户端的实测：换凭证时
   * comm 照样送 6、musicid 是不失真的整数字面量才成功；comm 送 1 回 1000，id 送成字符串回 10006，
   * id 失真回 50006。拿扫码票据按手机 QQ 读登录用户回 1000。
   */
  wechatBoundApp?: boolean;
  /** 上面这个账号的 id（十进位），默认 456。 */
  appUin?: string;
  /** 换凭证（两个通道的 Login，不含刷新）回这个单项码。 */
  exchangeCode?: number;
  /** 换凭证回这个网关码（顶层 code）。 */
  exchangeGlobalCode?: number;
  /** 换凭证回应的 HTTP 状态。 */
  exchangeHttpStatus?: number;
  /** 登录过程里读登录用户（手机 QQ 的回退验证、微信的验证）回这个单项码。 */
  loginUserCode?: number;
  /** 微信刷新凭证（loginMode 2）回这个单项码。 */
  refreshCode?: number;
  /**
   * 让登录之后的鉴权调用带上这个上游码。用来分别验证「凭证被明确拒绝」与「上游因为别的原因失败」
   * 走的是两条不同的路。QQ 通道的登录流程本身不打 GetLoginUserInfo，所以只影响登录后的调用。
   */
  postLoginUpstreamCode?: number;
  /** 上游交代的 musickey 寿命，用来验证会话到期时间是跟着它走而不是硬编 24 小时。 */
  credentialLifetime?: { musickeyCreateTime: number; keyExpiresIn: number };
}

/**
 * Stands in for the WeChat web endpoints. It is a separate client on purpose: the real service
 * builds one per QR session so the weixin.qq.com cookie jar never mixes with the musicu one.
 */
const createWechatHttpStub = (options: HarnessOptions) => {
  const requests: AxiosRequestConfig[] = [];
  // The last entry keeps being served, so a test can hold a state and then push the next one.
  const statuses = [
    ...(options.wechatStatuses ?? [
      wxStatusBody(408),
      wxStatusBody(404),
      wxStatusBody(405, WX_CODE),
    ]),
  ];
  let polls = 0;
  const request = jest.fn(async (config: AxiosRequestConfig) => {
    requests.push(config);
    const url = String(config.url);
    if (url === 'https://open.weixin.qq.com/connect/qrconnect') {
      return response(
        options.wechatQrPage ??
          `<img class="qrcode" src="/connect/qrcode/${WX_UUID}">` +
            `<a href="https://open.weixin.qq.com/connect/confirm?uuid=${WX_UUID}">open</a>`,
      );
    }
    if (url.includes('/connect/qrcode/')) return response(options.wechatImage ?? WX_PNG);
    if (url.includes('/l/qrconnect')) {
      const body = statuses[Math.min(polls, statuses.length - 1)];
      polls += 1;
      return response(body);
    }
    throw new Error(`Unexpected WeChat URL: ${url}`);
  });
  return {
    requests,
    pushStatus: (body: string) => statuses.push(body),
    client: {
      getCookieHeader: () => '',
      request: request as unknown as AuthHttpClient['request'],
      post: jest.fn(),
    } as unknown as AuthHttpClient,
  };
};

const createProtocolHarness = (options: HarnessOptions = {}) => {
  const deviceRepository = options.deviceRepository ?? createMemoryDeviceContextRepository();
  const calls: string[] = [];
  const comms: Record<string, unknown>[] = [];
  const post = jest.fn(
    async <T>(
      _url: string,
      sent?: unknown,
      _config?: AxiosRequestConfig,
    ): Promise<AxiosResponse<T>> => {
      // 要送不失真长整数的请求会先序列化成字符串；其他请求照旧是对象。
      const rawBody = typeof sent === 'string' ? sent : undefined;
      const payload: unknown = rawBody === undefined ? sent : JSON.parse(rawBody);
      if (!dictionaryOf(payload).req_0) {
        calls.push('GetQimei');
        if (options.qimei) return options.qimei() as AxiosResponse<T>;
        return response({
          data: JSON.stringify({ code: 0, data: { q16: QIMEI_16, q36: QIMEI_36 } }),
        } as T);
      }
      const method = methodOf(payload);
      calls.push(method);
      comms.push(dictionaryOf(dictionaryOf(payload).comm));
      if (method === 'GetSession') {
        if (options.sessionFailure) throw options.sessionFailure;
        return response({
          code: 0,
          req_0: { code: 0, data: { session: { uid: 1234567890, sid: 'session-sid' } } },
        } as T);
      }
      if (method === 'CreateQRCode') {
        if (options.qrFailure) throw options.qrFailure;
        const png = Buffer.from('89504e470d0a1a0a01020304', 'hex').toString('base64');
        return response({
          code: 0,
          req_0: { code: 0, data: { qrcodeID: 'qr-id', qrcode: png, expiresIn: 180 } },
        } as T);
      }
      if (options.wechatBoundApp) {
        const comm = dictionaryOf(dictionaryOf(payload).comm);
        const param = dictionaryOf(dictionaryOf(dictionaryOf(payload).req_0).param);
        if (method === 'Login' && param.qrCodeID !== undefined) {
          const uin = options.appUin ?? '456';
          // 请求体里 musicid 的原文：不带引号的数字才算整数字面量。
          const literal =
            rawBody === undefined
              ? typeof param.musicid === 'number'
                ? String(param.musicid)
                : undefined
              : /"musicid":(\d+)[,}]/.exec(rawBody)?.[1];
          const code =
            comm.tmeLoginType === 1
              ? 1000
              : typeof param.musicid === 'string'
                ? 10006
                : comm.tmeLoginType === 6 && literal === uin
                  ? 0
                  : 50006;
          return response(
            code === 0
              ? ({
                  code: 0,
                  req_0: {
                    code: 0,
                    data: {
                      musicid: 0,
                      str_musicid: uin,
                      musickey: 'app-wechat-key',
                      encryptUin: 'wechat-encrypt-uin',
                      refresh_key: 'app-wechat-refresh-key',
                      loginType: 1,
                    },
                  },
                } as T)
              : ({ code: 0, req_0: { code, data: {} } } as T),
          );
        }
        if (method === 'GetLoginUserInfo' && comm.tmeLoginType !== 1)
          return response({ code: 0, req_0: { code: 1000, data: {} } } as T);
      }
      if (method === 'Login' && options.failCredential) {
        return response({ code: 0, req_0: { code: 50006, data: {} } } as T);
      }
      if (method === 'Login') {
        const param = dictionaryOf(dictionaryOf(dictionaryOf(payload).req_0).param);
        if (param.loginMode === 2 && options.refreshCode !== undefined)
          return response({ code: 0, req_0: { code: options.refreshCode, data: {} } } as T);
        if (
          param.loginMode !== 2 &&
          (options.exchangeCode !== undefined || options.exchangeGlobalCode !== undefined)
        )
          return response(
            {
              code: options.exchangeGlobalCode ?? 0,
              req_0: { code: options.exchangeCode ?? 0, data: {} },
            } as T,
            options.exchangeHttpStatus ?? 200,
          );
      }
      if (method === 'GetLoginUserInfo' && options.loginUserCode !== undefined)
        return response({ code: 0, req_0: { code: options.loginUserCode, data: {} } } as T);
      if (method === 'Login') {
        const param = dictionaryOf(dictionaryOf(dictionaryOf(payload).req_0).param);
        if (param.loginMode === 2) {
          const loginType = Number(dictionaryOf(dictionaryOf(payload).comm).tmeLoginType);
          return response({
            code: 0,
            req_0: {
              code: 0,
              data: {
                musicid: loginType === 1 ? 456 : 123,
                str_musicid: loginType === 1 ? '456' : '123',
                musickey: loginType === 1 ? 'wechat-refreshed-key' : 'qq-refreshed-key',
                openid: 'wechat-openid',
                refresh_token: 'wechat-refresh-token-2',
                refresh_key: 'wechat-refresh-key-2',
                unionid: 'wechat-unionid',
                encryptUin: 'wechat-encrypt-uin',
                nick: '我的微信账号',
              },
            },
          } as T);
        }
        // The WeChat exchange returns no loginType, so the channel default has to fill it in.
        if (param.strAppid)
          return response({
            code: 0,
            req_0: {
              code: 0,
              data: {
                musicid: options.placeholderMusicId ? 0 : 456,
                str_musicid: '456',
                musickey: 'wechat-credential-key',
                openid: 'wechat-openid',
                refresh_token: 'wechat-refresh-token',
                refresh_key: 'wechat-refresh-key',
                unionid: 'wechat-unionid',
                encryptUin: 'wechat-encrypt-uin',
                nick: '我的微信账号',
              },
            },
          } as T);
        return response({
          code: 0,
          req_0: {
            code: 0,
            data: {
              musicid: 123,
              musickey: 'credential-key',
              loginType: 6,
              ...(options.credentialLifetime ?? {}),
            },
          },
        } as T);
      }
      // 只覆盖登录之后才会打的两个方法，登录流程本身（GetSession / QIMEI / Login）不受影响。
      if (
        options.postLoginUpstreamCode !== undefined &&
        (method === 'GetLoginUserInfo' || method === 'GetPlaylistByUin')
      )
        return response({
          code: 0,
          req_0: { code: options.postLoginUpstreamCode, data: {} },
        } as T);
      if (method === 'GetLoginUserInfo' && options.failCredential) {
        return response({ code: 0, req_0: { code: 50006, data: {} } } as T);
      }
      if (method === 'GetLoginUserInfo') {
        const comm = dictionaryOf(dictionaryOf(payload).comm);
        // 只拒绝那把还没换过的 key。刷新之后上游会认新的 key，这正是刷新的意义；如果连刷新后的凭证
        // 也一直回 1000，那就不是「需要刷新」而是「这个账号登不上」，不该由这个夹具来模拟。
        if (options.wechatNeedsRefresh && comm.authst === 'wechat-credential-key')
          return response({ code: 0, req_0: { code: 1000, data: {} } } as T);
        if (options.nestedProfileOnly)
          return response({
            code: 0,
            req_0: {
              code: 0,
              data: {
                errMsg: '',
                identify: '',
                celebrityInfo: { uin: 0 },
                info: {
                  nick: '我的 QQ 账号',
                  logo: 'https://thirdqq.example.test/avatar',
                  gender: 0,
                },
              },
            },
          } as T);
        return response({
          code: 0,
          req_0: {
            code: 0,
            data: {
              musicid: comm.tmeLoginType === 1 ? 456 : 123,
              nickname: comm.tmeLoginType === 1 ? '我的微信账号' : '我的 QQ 账号',
              musickey: 'must-not-leak',
            },
          },
        } as T);
      }
      if (method === 'GetPlaylistByUin') {
        return response({
          code: 0,
          req_0: {
            code: 0,
            data: { v_playlist: [{ tid: 7, dirName: '我喜欢' }], total: 1, bFinish: true },
          },
        } as T);
      }
      if (method === 'CgiGetPlaylistFavInfo') {
        return response({
          code: 0,
          req_0: {
            code: 0,
            data: {
              v_list: [{ id: 8, title: '收藏歌单', songnum: 3 }],
              total: 1,
              hasmore: 0,
            },
          },
        } as T);
      }
      if (method === 'CgiGetDiss') {
        return response({
          code: 0,
          req_0: {
            code: 0,
            data: {
              songlist: [{ id: 9, mid: 'liked-song-mid', name: '收藏歌曲' }],
              songlist_size: 1,
              total_song_num: 1,
              hasmore: 0,
            },
          },
        } as T);
      }
      if (method === 'CgiGetVkey' || method === 'UrlGetVkey') {
        const param = dictionaryOf(dictionaryOf(dictionaryOf(payload).req_0).param);
        const songmid = Array.isArray(param.songmid) ? String(param.songmid[0] ?? '') : '';
        return response({
          code: 0,
          req_0: {
            code: 0,
            data: {
              sip: options.emptyVkeySip ? [] : ['https://audio.example.test/'],
              midurlinfo: [{ songmid, purl: 'fixture.flac' }],
            },
          },
        } as T);
      }
      if (method === 'GetCdnDispatch') {
        return response({
          code: 0,
          req_0: {
            code: 0,
            data: { sip: options.dispatchSips ?? [], refreshTime: 1_800 },
          },
        } as T);
      }
      throw new Error(`Unexpected method: ${method}`);
    },
  );
  /**
   * Only the favourite-album collection is read over a plain CGI instead of musicu, so this
   * stub serves that one URL. `sin`/`ein` bound an inclusive range, which is what it slices by.
   */
  const favoriteAlbumRequests: AxiosRequestConfig[] = [];
  const requestStub = jest.fn(async (config: AxiosRequestConfig) => {
    const url = String(config.url);
    if (!url.includes('fcg_get_profile_order_asset.fcg')) {
      throw new Error(`Unexpected auth request URL: ${url}`);
    }
    favoriteAlbumRequests.push(config);
    if (options.favoriteAlbumCode) return response({ code: options.favoriteAlbumCode });
    if (options.favoriteAlbumBody !== undefined) return response(options.favoriteAlbumBody);
    const params = dictionaryOf(config.params);
    const sin = Number(params.sin ?? 0);
    const ein = Number(params.ein ?? 0);
    const albums = options.favoriteAlbums ?? [
      {
        albumid: 88971,
        albummid: '000MkMni19ClKG',
        albumname: '范特西',
        singermid: '0025NhlN2yWrP4',
      },
      {
        albumid: 88972,
        albummid: '002J4UUk29y8BY',
        albumname: '八度空间',
        singermid: '0025NhlN2yWrP4',
      },
    ];
    return response({
      code: 0,
      subcode: 0,
      data: {
        albumlist: albums.slice(sin, ein + 1),
        totalalbum: albums.length,
        has_more: ein + 1 < albums.length ? 1 : 0,
      },
    });
  });
  const http: AuthHttpClient = {
    getCookieHeader: () => '',
    request: requestStub as unknown as AuthHttpClient['request'],
    post: post as unknown as AuthHttpClient['post'],
  };
  let emit: ((event: TestQrEvent) => void) | undefined;
  let rejectListener: ((error: Error) => void) | undefined;
  let closed = false;
  const wechat = createWechatHttpStub(options);
  const service = createQrLoginService({
    http,
    streamUrlProbe: options.streamUrlProbe,
    deviceRepository,
    authSessionRepository: options.authSessionRepository,
    sessionResolver: options.sessionResolver,
    createSessionHttp: () => wechat.client,
    now: options.now,
    randomBytes: (size) => Buffer.alloc(size, 7),
    listen: (qrcodeId, onEvent, timeoutMs) => {
      emit = onEvent;
      if (options.mqttConnect)
        return createMqttListenOver(options.mqttConnect)(qrcodeId, onEvent, timeoutMs);
      onEvent({ type: 'waiting', payload: null });
      return {
        ready: options.listenerReadyFailure
          ? Promise.reject(new Error(options.listenerReadyFailure))
          : Promise.resolve(),
        done: new Promise<void>((_resolve, reject) => {
          rejectListener = reject;
        }),
        close: () => {
          closed = true;
        },
      };
    },
  });
  return {
    calls,
    comms,
    httpPost: post,
    favoriteAlbumRequests,
    deviceRepository,
    service,
    wechatRequests: wechat.requests,
    pushWechatStatus: wechat.pushStatus,
    emit: (event: TestQrEvent) => {
      if (!emit) throw new Error('listener not started');
      emit(event);
    },
    failListener: () => {
      if (!rejectListener) throw new Error('listener not started');
      rejectListener(new Error(options.listenerFailure ?? 'MQTT WebSocket closed'));
    },
    wasClosed: () => closed,
  };
};

// Yields with a timer rather than setImmediate: the WeChat poll loop waits on setTimeout, and
// a setImmediate loop can burn 200 turns of the event loop without a millisecond of wall clock
// ever passing, so the poll would never get its turn.
const waitFor = async (predicate: () => boolean | Promise<boolean>): Promise<void> => {
  for (let index = 0; index < 200; index += 1) {
    if (await predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('condition was not reached');
};

const login = async (service: QrLoginService, emit: (event: TestQrEvent) => void) => {
  const key = await service.createSession();
  const imageUrl = await service.createQr(key);
  emit({ type: 'scanned', payload: {} });
  emit({
    type: 'cookies',
    payload: { cookies: { qqmusic_uin: { value: '123' }, qqmusic_key: { value: 'mqtt-key' } } },
  });
  await waitFor(async () => (await service.checkQr(key)).code === 803);
  return { key, imageUrl, result: await service.checkQr(key) };
};

// A broker that acknowledges CONNECT/SUBSCRIBE and reports close like a real WebSocket.
const createClosingMqtt = () => {
  const sockets: Array<{ close(): void }> = [];
  const connect: MqttConnect = async (_url, _protocol, handlers) => {
    let closed = false;
    const socket = {
      send: (packet: Uint8Array) => {
        if (packet[0] >> 4 === 1) handlers.message(Buffer.from([0x20, 0x03, 0, 0, 0]));
        if (packet[0] >> 4 === 8) handlers.message(Buffer.from([0x90, 0x04, 0, 1, 0, 0]));
      },
      close: () => {
        if (closed) return;
        closed = true;
        handlers.close();
      },
    };
    sockets.push(socket);
    return socket;
  };
  return {
    connect,
    close: () => {
      for (const socket of sockets) socket.close();
    },
  };
};

const settleMqttClose = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('QQ QR session teardown', () => {
  it('should allow a new QR after intentional cancellation closes the MQTT socket', async () => {
    const mqtt = createClosingMqtt();
    const harness = createProtocolHarness({ mqttConnect: mqtt.connect });
    try {
      const key = await harness.service.createSession();
      await harness.service.createQr(key);
      harness.service.cancelSession(key);
      await settleMqttClose();

      const next = await harness.service.createSession();
      await harness.service.createQr(next);
      expect(await harness.service.checkQr(next)).toMatchObject({ code: 801 });
      harness.service.cancelSession(next);
    } finally {
      mqtt.close();
    }
  });

  it('should not back off when replacing an unscanned QR closes its MQTT socket', async () => {
    const mqtt = createClosingMqtt();
    const harness = createProtocolHarness({ mqttConnect: mqtt.connect });
    try {
      const first = await harness.service.createSession();
      await harness.service.createQr(first);
      await harness.service.createSession();
      await settleMqttClose();

      await expect(harness.service.createSession()).resolves.toEqual(expect.any(String));
    } finally {
      mqtt.close();
    }
  });

  it('should ignore a queued terminal event from a cancelled QR', async () => {
    const harness = createProtocolHarness();
    const key = await harness.service.createSession();
    await harness.service.createQr(key);
    harness.service.cancelSession(key);
    harness.emit({ type: 'timeout', payload: null });

    await expect(harness.service.createSession()).resolves.toEqual(expect.any(String));
  });

  it('should apply only one backoff when expiry cleanup closes the MQTT socket', async () => {
    const mqtt = createClosingMqtt();
    let current = Date.now();
    const harness = createProtocolHarness({ mqttConnect: mqtt.connect, now: () => current });
    try {
      const key = await harness.service.createSession();
      await harness.service.createQr(key);
      current += 181_000;
      expect(await harness.service.checkQr(key)).toMatchObject({ code: 800 });
      await settleMqttClose();

      await expect(harness.service.createSession()).rejects.toMatchObject({
        httpStatus: 429,
        retryAfterMs: 15000,
        diagnostics: {
          failureReason: 'local-backoff',
          lastFailure: { failureStage: 'qr-event', failureReason: 'qr-timeout' },
        },
      });
    } finally {
      mqtt.close();
    }
  });

  it('should still back off when a live MQTT connection closes unexpectedly', async () => {
    const mqtt = createClosingMqtt();
    const harness = createProtocolHarness({ mqttConnect: mqtt.connect });
    try {
      const key = await harness.service.createSession();
      await harness.service.createQr(key);
      mqtt.close();
      await settleMqttClose();

      expect(await harness.service.checkQr(key)).toMatchObject({
        code: 800,
        message: 'QR login failed',
      });
      await expect(harness.service.createSession()).rejects.toMatchObject({ httpStatus: 429 });
    } finally {
      mqtt.close();
    }
  });
});

describe('QQ QR startup diagnostics', () => {
  it.each([
    99, 100, 599, 600, 200.5,
  ])('should validate restored HTTP status %s independently of signed upstream codes', async (status) => {
    const service = createQrLoginService({
      qrSessionRepository: {
        kind: 'test',
        save: () => undefined,
        load: () => [
          {
            key: 'key',
            channel: 'qq',
            state: 'failed',
            createdAt: Date.now(),
            expiresAt: Date.now() + 60000,
            failureStage: 'qr-create',
            failureReason: 'upstream-rejected',
            upstreamHttpStatus: status,
            upstreamCode: -30002,
            upstreamGlobalCode: 0,
            upstreamSubCode: -99,
          },
        ],
      },
    });
    const result = await service.checkQr('key');
    expect(result.upstreamCode).toBe(-30002);
    expect(result.upstreamHttpStatus).toBe(status === 100 || status === 599 ? status : undefined);
  });

  it('should classify a thrown primitive as unknown without exposing its content', async () => {
    const harness = createProtocolHarness({
      qimei: () => {
        throw 'private-token';
      },
    });
    const result = await harness.service.createSession().catch((error: unknown) => error);
    expect(result).toMatchObject({
      diagnostics: { failureStage: 'device-bootstrap', failureReason: 'unexpected-error' },
    });
    expect(JSON.stringify(result)).not.toContain('private-token');
  });

  it.each([
    ['MQTT WebSocket error', 'mqtt-websocket-error'],
    ['MQTT WebSocket closed', 'mqtt-websocket-closed'],
    ['MQTT packet timeout', 'mqtt-packet-timeout'],
    ['MQTT handshake timeout', 'mqtt-handshake-timeout'],
    ['MQTT handshake failed', 'mqtt-handshake-failed'],
    ['constructor', 'unexpected-error'],
    ['private-token and private-cookie', 'unexpected-error'],
  ])('should map listener error %s to a fixed category', async (message, reason) => {
    const harness = createProtocolHarness({ listenerFailure: message });
    const key = await harness.service.createSession();
    await harness.service.createQr(key);
    harness.failListener();
    await settleMqttClose();
    const result = await harness.service.checkQr(key);
    expect(result).toMatchObject({ failureStage: 'mqtt-listener', failureReason: reason });
    expect(JSON.stringify(result)).not.toMatch(/private-token|private-cookie/);
  });

  it.each([
    ['ETIMEDOUT', 'network-timeout'],
    ['ECONNABORTED', 'network-timeout'],
    ['ERR_NETWORK', 'network-error'],
    ['unrecognised-private-code', 'unexpected-error'],
  ])('should map transport code %s without copying the error', async (code, reason) => {
    const harness = createProtocolHarness({
      qrFailure: Object.assign(new Error('private-token'), { code }),
    });
    const key = await harness.service.createSession();
    await harness.service.createQr(key).catch(() => undefined);
    const result = await harness.service.checkQr(key);
    expect(result).toMatchObject({ failureStage: 'qr-create', failureReason: reason });
    expect(JSON.stringify(result)).not.toContain('private-token');
  });

  it.each([
    'TimeoutError',
    'AbortError',
  ])('should classify fetch %s without exposing its message', async (name) => {
    const failure = Object.assign(new Error('private-url'), { name });
    const harness = createProtocolHarness({ sessionFailure: failure });
    const result = await harness.service.createSession().catch((error: unknown) => error);
    expect(result).toMatchObject({ diagnostics: { failureReason: 'network-timeout' } });
    expect(JSON.stringify(result)).not.toContain('private-url');
  });

  it('should retain signed upstream and global codes on a QR creation rejection', async () => {
    const harness = createProtocolHarness({
      qrFailure: new QqProtocolError('create-qr', -5, 500, 200),
    });
    const key = await harness.service.createSession();
    const failure = await harness.service.createQr(key).catch((error: unknown) => error);
    const details = {
      failureStage: 'qr-create',
      failureReason: 'upstream-rejected',
      upstreamHttpStatus: 200,
      upstreamCode: -5,
      upstreamGlobalCode: 500,
    };
    expect(failure).toMatchObject({ diagnostics: details });
    expect(await harness.service.checkQr(key)).toMatchObject(details);
  });

  it('should identify session issue failures after credential exchange', async () => {
    const harness = createProtocolHarness({
      sessionResolver: {
        mode: 'stored',
        resolve: async () => null,
        revoke: async () => undefined,
        issue: async () => {
          throw new Error('private-cookie');
        },
      },
    });
    const key = await harness.service.createSession();
    await harness.service.createQr(key);
    harness.emit({
      type: 'cookies',
      payload: { cookies: { qqmusic_uin: { value: '123' }, qqmusic_key: { value: 'mqtt-key' } } },
    });
    await waitFor(async () => (await harness.service.checkQr(key)).code === 800);
    const result = await harness.service.checkQr(key);
    expect(result).toMatchObject({
      code: 800,
      failureStage: 'session-issue',
      failureReason: 'unexpected-error',
    });
    expect(JSON.stringify(result)).not.toContain('private-cookie');
  });

  it('should keep successful confirmation free of previous bootstrap diagnostics', async () => {
    let now = Date.now();
    let first = true;
    const harness = createProtocolHarness({
      now: () => now,
      qimei: () => {
        if (first) {
          first = false;
          return response({ code: -30002 });
        }
        return response({
          data: JSON.stringify({ code: 0, data: { q16: QIMEI_16, q36: QIMEI_36 } }),
        });
      },
    });
    await expect(harness.service.createSession()).rejects.toMatchObject({ httpStatus: 502 });
    now += 30001;
    const { result } = await login(harness.service, harness.emit);
    expect(result.code).toBe(803);
    expect(JSON.stringify(result)).not.toMatch(/failureStage|lastFailure|upstreamCode/);
    await expect(harness.service.createSession()).resolves.toEqual(expect.any(String));
  });

  it('should identify a QR already being confirmed without altering its state', async () => {
    const harness = createProtocolHarness();
    const key = await harness.service.createSession();
    await harness.service.createQr(key);
    harness.emit({ type: 'scanned', payload: null });
    await expect(harness.service.createSession()).rejects.toMatchObject({
      httpStatus: 409,
      diagnostics: { failureStage: 'qr-key', failureReason: 'session-busy' },
    });
    expect(await harness.service.checkQr(key)).toMatchObject({ code: 802 });
  });

  it('should remove untrusted diagnostic fields from a restored QR record', async () => {
    const service = createQrLoginService({
      qrSessionRepository: {
        kind: 'test',
        save: () => undefined,
        load: () => [
          {
            key: 'key',
            channel: 'qq',
            state: 'failed',
            createdAt: Date.now(),
            expiresAt: Date.now() + 60000,
            failureStage: 'private-token',
            failureReason: 'private-cookie',
            upstreamCode: 'private-account',
            upstreamHttpStatus: 999,
            upstreamGlobalCode: Number.NaN,
            upstreamSubCode: Number.POSITIVE_INFINITY,
          },
        ],
      },
    });
    const result = await service.checkQr('key');
    expect(result.code).toBe(800);
    expect(JSON.stringify(result)).not.toMatch(/private-|999/);
    expect(result).not.toHaveProperty('upstreamHttpStatus', 999);
  });

  it('should retain QIMEI failure codes in the first error and the subsequent backoff', async () => {
    const harness = createProtocolHarness({
      qimei: () => response({ code: -30002, data: JSON.stringify({ code: -99 }) }),
    });
    const first = await harness.service.createSession().catch((error: unknown) => error);
    const repeated = await harness.service.createSession().catch((error: unknown) => error);
    const details = {
      failureStage: 'device-bootstrap',
      failureReason: 'upstream-rejected',
      upstreamHttpStatus: 200,
      upstreamCode: -30002,
      upstreamSubCode: -99,
    };
    expect(first).toMatchObject({ httpStatus: 502, diagnostics: details });
    expect(repeated).toMatchObject({
      httpStatus: 429,
      diagnostics: { failureStage: 'qr-key', failureReason: 'local-backoff', lastFailure: details },
    });
    expect(harness.calls).toEqual(['GetQimei']);
  });

  it('should identify GetSession failures without including the upstream body or message', async () => {
    const failure = Object.assign(new Error('secret-url?cookie=private-cookie'), {
      response: { status: 503, data: { token: 'private-token' } },
    });
    const harness = createProtocolHarness({ sessionFailure: failure });
    const result = await harness.service.createSession().catch((error: unknown) => error);
    expect(result).toMatchObject({
      httpStatus: 502,
      diagnostics: {
        failureStage: 'session-bootstrap',
        failureReason: 'upstream-http-error',
        upstreamHttpStatus: 503,
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/private-cookie|private-token|secret-url/);
  });

  it('should preserve QR creation diagnostics in both the thrown error and check response', async () => {
    const harness = createProtocolHarness({
      qrFailure: Object.assign(new Error('private-token'), { code: 'ETIMEDOUT' }),
    });
    const key = await harness.service.createSession();
    const failure = await harness.service.createQr(key).catch((error: unknown) => error);
    const details = { failureStage: 'qr-create', failureReason: 'network-timeout' };
    expect(failure).toMatchObject({ httpStatus: 502, diagnostics: details });
    expect(await harness.service.checkQr(key)).toMatchObject(details);
    expect(JSON.stringify(failure)).not.toContain('private-token');
  });

  it('should identify MQTT readiness failures as listener failures', async () => {
    const harness = createProtocolHarness({ listenerReadyFailure: 'MQTT handshake failed' });
    const key = await harness.service.createSession();
    const failure = await harness.service.createQr(key).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      diagnostics: { failureStage: 'mqtt-listener', failureReason: 'mqtt-handshake-failed' },
    });
  });

  it('should retain a failed MQTT session as the origin of the next cooldown', async () => {
    const harness = createProtocolHarness();
    const key = await harness.service.createSession();
    await harness.service.createQr(key);
    harness.failListener();
    await settleMqttClose();
    const failure = await harness.service.createSession().catch((error: unknown) => error);
    expect(failure).toMatchObject({
      httpStatus: 429,
      diagnostics: {
        failureStage: 'qr-key',
        failureReason: 'local-backoff',
        lastFailure: { failureStage: 'mqtt-listener', failureReason: 'mqtt-websocket-closed' },
      },
    });
  });

  it.each([
    ['ENOTFOUND', 'dns-error'],
    ['EAI_AGAIN', 'dns-error'],
    ['ECONNRESET', 'connection-reset'],
    ['ECONNREFUSED', 'connection-refused'],
  ])('should classify fetch cause code %s safely', async (code, reason) => {
    const failure = Object.assign(new TypeError('fetch failed with private-token'), {
      cause: { code },
    });
    const harness = createProtocolHarness({ sessionFailure: failure });
    const result = await harness.service.createSession().catch((error: unknown) => error);
    expect(result).toMatchObject({ diagnostics: { failureReason: reason } });
    expect(JSON.stringify(result)).not.toContain('private-token');
  });
});

describe('QQ native QR login service', () => {
  it('should move through waiting, scanned, and confirmed states', async () => {
    const harness = createProtocolHarness();
    const key = await harness.service.createSession();
    const imageUrl = await harness.service.createQr(key);

    expect(imageUrl).toMatch(/^data:image\/png;base64,/);
    expect(await harness.service.checkQr(key)).toMatchObject({ code: 801 });
    harness.emit({ type: 'scanned', payload: {} });
    expect(await harness.service.checkQr(key)).toMatchObject({ code: 802 });
    harness.emit({
      type: 'cookies',
      payload: { cookies: { qqmusic_uin: { value: '123' }, qqmusic_key: { value: 'mqtt-key' } } },
    });
    await waitFor(async () => (await harness.service.checkQr(key)).code === 803);

    const confirmed = await harness.service.checkQr(key);
    expect(confirmed).toMatchObject({
      code: 803,
      cookie: expect.stringMatching(/^qqmusic_session=/),
    });
    expect(confirmed.cookie).not.toContain('credential-key');
    expect(confirmed.cookie).not.toContain('mqtt-key');
  });

  it('should reject a parallel QR session that is already being confirmed on the phone', async () => {
    const harness = createProtocolHarness();
    const key = await harness.service.createSession();
    await harness.service.createQr(key);
    harness.emit({ type: 'scanned', payload: {} });

    await expect(harness.service.createSession()).rejects.toEqual(
      expect.objectContaining({ httpStatus: 409 }),
    );
  });

  it('should preempt an unscanned session so a reopened dialog is not stuck behind the TTL', async () => {
    const harness = createProtocolHarness();
    const first = await harness.service.createSession();
    await harness.service.createQr(first);

    // No cancel is sent here on purpose: this is the hard-quit case, where the client never got
    // the chance to release the session it left behind.
    await expect(harness.service.createSession()).resolves.toEqual(expect.any(String));
    expect(harness.wasClosed()).toBe(true);
  });

  it('should release one session by key and let the next login start immediately', async () => {
    const harness = createProtocolHarness();
    const key = await harness.service.createSession();
    await harness.service.createQr(key);

    harness.service.cancelSession(key);

    expect(harness.wasClosed()).toBe(true);
    expect(await harness.service.checkQr(key)).toMatchObject({ code: 800 });
    await expect(harness.service.createSession()).resolves.toEqual(expect.any(String));
  });

  it('should treat cancelling an unknown or already cancelled key as a success', async () => {
    const harness = createProtocolHarness();
    const key = await harness.service.createSession();

    expect(() => harness.service.cancelSession('never-issued')).not.toThrow();
    expect(() => harness.service.cancelSession(key)).not.toThrow();
    expect(() => harness.service.cancelSession(key)).not.toThrow();
  });

  it('should keep a confirmed session readable after a late cancel', async () => {
    const harness = createProtocolHarness();
    const { key } = await login(harness.service, harness.emit);

    harness.service.cancelSession(key);

    expect(await harness.service.checkQr(key)).toMatchObject({ code: 803 });
  });

  it('should preserve upstream 50006 and apply a retry backoff', async () => {
    const harness = createProtocolHarness({ failCredential: true });
    const key = await harness.service.createSession();
    await harness.service.createQr(key);
    harness.emit({
      type: 'cookies',
      payload: { cookies: { qqmusic_uin: { value: '123' }, qqmusic_key: { value: 'mqtt-key' } } },
    });
    await waitFor(async () => (await harness.service.checkQr(key)).code === 800);

    expect(await harness.service.checkQr(key)).toEqual(
      expect.objectContaining({
        code: 800,
        upstreamCode: 50006,
        retryAfterMs: 15000,
        failureStage: 'credential-validation',
        failureReason: 'upstream-rejected',
      }),
    );
    const retryError = await harness.service.createSession().catch((error: unknown) => error);
    expect(retryError).toBeInstanceOf(QrLoginServiceError);
    expect(retryError).toEqual(expect.objectContaining({ httpStatus: 429 }));
    expect((retryError as QrLoginServiceError).retryAfterMs).toBeGreaterThan(14000);
  });

  it('should report a safe MQTT failure after the QR was scanned', async () => {
    const harness = createProtocolHarness({ listenerFailure: 'MQTT WebSocket closed' });
    const key = await harness.service.createSession();
    await harness.service.createQr(key);
    harness.emit({ type: 'scanned', payload: {} });
    harness.failListener();
    await waitFor(async () => (await harness.service.checkQr(key)).code === 800);

    expect(await harness.service.checkQr(key)).toMatchObject({
      code: 800,
      failureStage: 'mqtt-listener',
      failureReason: 'mqtt-websocket-closed',
    });
  });

  it('should not echo unknown listener errors or credentials in QR diagnostics', async () => {
    const secret = 'qqmusic_key=private-credential';
    const harness = createProtocolHarness({ listenerFailure: secret });
    const key = await harness.service.createSession();
    await harness.service.createQr(key);
    harness.failListener();
    await waitFor(async () => (await harness.service.checkQr(key)).code === 800);

    const result = await harness.service.checkQr(key);
    expect(result).toMatchObject({
      failureStage: 'mqtt-listener',
      failureReason: 'unexpected-error',
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain(key);
  });

  it('should identify a QR login rejection delivered by the MQTT event', async () => {
    const harness = createProtocolHarness();
    const key = await harness.service.createSession();
    await harness.service.createQr(key);
    harness.emit({ type: 'scanned', payload: {} });
    harness.emit({ type: 'loginFailed', payload: null });

    expect(await harness.service.checkQr(key)).toMatchObject({
      code: 800,
      failureStage: 'qr-event',
      failureReason: 'login-rejected',
    });
  });

  it('should identify a missing credential without returning the MQTT payload', async () => {
    const harness = createProtocolHarness();
    const key = await harness.service.createSession();
    await harness.service.createQr(key);
    harness.emit({
      type: 'cookies',
      payload: { cookies: { qqmusic_key: { value: 'private-key' } } },
    });
    await waitFor(async () => (await harness.service.checkQr(key)).code === 800);

    const result = await harness.service.checkQr(key);
    expect(result).toMatchObject({
      failureStage: 'credential-payload',
      failureReason: 'missing-credential',
    });
    expect(JSON.stringify(result)).not.toContain('private-key');
  });

  it('should expose authenticated user and playlist without exposing credentials', async () => {
    const harness = createProtocolHarness();
    const { result } = await login(harness.service, harness.emit);
    const token = result.cookie?.split('=')[1];

    await expect(harness.service.getLoginStatus(token)).resolves.toMatchObject({
      nickname: '我的 QQ 账号',
    });
    await expect(harness.service.getLoginStatus(token)).resolves.not.toHaveProperty('musickey');
    await expect(harness.service.getUserDetail(token)).resolves.toMatchObject({ musicid: 123 });
    await expect(harness.service.getUserPlaylists(token)).resolves.toMatchObject({
      v_playlist: [{ tid: 7, dirName: '我喜欢' }],
    });
    expect(harness.calls).toContain('GetLoginUserInfo');
    expect(harness.calls).toContain('GetPlaylistByUin');
  });

  it('should keep the account id when the profile reply carries none', async () => {
    const harness = createProtocolHarness({ nestedProfileOnly: true });
    const { result } = await login(harness.service, harness.emit);
    const token = result.cookie?.split('=')[1];

    // The real reply nests every account field under `info` and has no id, so the id can only
    // come from the credential underneath — while `info` still has to survive untouched.
    const profile = await harness.service.getLoginStatus(token);
    expect(profile).toMatchObject({
      musicid: '123',
      str_musicid: '123',
      info: { nick: '我的 QQ 账号', logo: 'https://thirdqq.example.test/avatar' },
    });
    expect(profile).not.toHaveProperty('musickey');
  });

  it('should publish the account id a WeChat credential keeps out of its placeholder field', async () => {
    const harness = createProtocolHarness({ nestedProfileOnly: true, placeholderMusicId: true });
    const key = await harness.service.createSession('wechat');
    await harness.service.createQr(key);
    await waitFor(async () => (await harness.service.checkQr(key)).code === 803);
    const token = (await harness.service.checkQr(key)).cookie?.split('=')[1];

    // A WeChat credential holds `musicid: 0`; publishing that raw would hand callers an id every
    // upstream call rejects — `/user/playlist?uid=0` answers with none of the created playlists.
    const profile = await harness.service.getLoginStatus(token);
    expect(profile).toMatchObject({ musicid: '456', str_musicid: '456' });

    // The same id the service keys its own reads on, so a caller echoing it back is a no-op.
    await harness.service.getUserPlaylists(token, '456');
    const playlistCall = jest
      .mocked(harness.httpPost)
      .mock.calls.find(([, payload]) => methodOf(payload) === 'GetPlaylistByUin');
    expect(dictionaryOf(dictionaryOf(dictionaryOf(playlistCall?.[1]).req_0).param)).toMatchObject({
      uin: '456',
    });
  });

  it('should resolve music URLs through the authenticated auth HTTP client', async () => {
    const harness = createProtocolHarness();
    const { result } = await login(harness.service, harness.emit);
    const token = result.cookie?.split('=')[1];

    await expect(
      harness.service.getMusicPlay(token, 'song-mid', 'flac', 'media-mid'),
    ).resolves.toEqual({
      'song-mid': {
        url: 'https://audio.example.test/fixture.flac',
        error: false,
        source: { kind: 'full', protocol: 'android-vkey', cdn: 'response-sip' },
      },
    });
    await expect(harness.service.getMusicPlay('unknown', 'song-mid', 'flac')).resolves.toBeNull();
    expect(harness.calls).toContain('UrlGetVkey');
    expect(harness.comms.at(-1)).toMatchObject({
      qq: '123',
      authst: 'credential-key',
      tmeLoginType: 6,
    });
    const vkeyPayload = dictionaryOf(
      dictionaryOf(dictionaryOf(jest.mocked(harness.httpPost).mock.calls.at(-1)?.[1])).req_0,
    );
    expect(vkeyPayload.module).toBe('music.vkey.GetVkey');
    expect(dictionaryOf(vkeyPayload.param)).toMatchObject({
      filename: ['F000song-midmedia-mid.flac'],
      songmid: ['song-mid'],
      songtype: [0],
      uin: '123',
      ctx: 0,
    });
    expect(dictionaryOf(vkeyPayload.param).guid).toMatch(/^[0-9a-f]{32}$/);
    expect(dictionaryOf(jest.mocked(harness.httpPost).mock.calls.at(-1)?.[2]).headers).toEqual(
      expect.objectContaining({
        Cookie: 'uin=123; qqmusic_uin=123; qm_keyst=credential-key; qqmusic_key=credential-key',
      }),
    );

    // media_mid 缺席时第二段用 songmid 补上；单段文件名会让 CDN 对合法 vkey 回 403。
    await harness.service.getMusicPlay(token, 'song-mid', 'flac');
    expect(
      dictionaryOf(
        dictionaryOf(
          dictionaryOf(dictionaryOf(jest.mocked(harness.httpPost).mock.calls.at(-1)?.[1])).req_0,
        ).param,
      ),
    ).toMatchObject({ filename: ['F000song-midsong-mid.flac'] });
  });

  it('should fall back to the stream host when the vkey response carries no sip', async () => {
    const harness = createProtocolHarness({ emptyVkeySip: true });
    const { result } = await login(harness.service, harness.emit);
    const token = result.cookie?.split('=')[1];

    // Without the fallback the URL degrades into a bare `fixture.flac`, which the browser then
    // resolves against its own origin instead of the CDN.
    await expect(
      harness.service.getMusicPlay(token, 'song-mid', 'flac', 'media-mid'),
    ).resolves.toEqual({
      'song-mid': {
        url: 'http://dl.stream.qqmusic.qq.com/fixture.flac',
        error: false,
        source: { kind: 'full', protocol: 'android-vkey', cdn: 'unverified-default' },
      },
    });
    expect(harness.calls).toContain('GetCdnDispatch');
  });

  it('should use sjy6 without dispatch when the preferred CDN accepts the signed URL', async () => {
    const streamUrlProbe = jest.fn(async (url: string) =>
      url.startsWith('http://sjy6.stream.qqmusic.qq.com/')
        ? { bytes: 262_144, elapsedMs: 100 }
        : null,
    );
    const harness = createProtocolHarness({ emptyVkeySip: true, streamUrlProbe });
    const { result } = await login(harness.service, harness.emit);
    const token = result.cookie?.split('=')[1];

    await expect(
      harness.service.getMusicPlay(token, 'song-mid', 'flac', 'media-mid'),
    ).resolves.toEqual({
      'song-mid': {
        url: 'http://sjy6.stream.qqmusic.qq.com/fixture.flac',
        error: false,
        source: { kind: 'full', protocol: 'android-vkey', cdn: 'probed' },
      },
    });
    expect(streamUrlProbe).toHaveBeenCalledTimes(1);
    expect(harness.calls).not.toContain('GetCdnDispatch');
  });

  it('should dispatch and select the fastest compatible CDN when sjy6 rejects the signed URL', async () => {
    const streamUrlProbe = jest.fn(async (url: string) => {
      if (url.startsWith('https://fast.stream.qqmusic.qq.com/'))
        return { bytes: 262_144, elapsedMs: 100 };
      if (url.startsWith('http://dl.stream.qqmusic.qq.com/'))
        return { bytes: 262_144, elapsedMs: 1_000 };
      return null;
    });
    const harness = createProtocolHarness({
      emptyVkeySip: true,
      dispatchSips: [
        'https://sjy6.stream.qqmusic.qq.com/',
        'https://blocked.stream.qqmusic.qq.com/',
        'https://fast.stream.qqmusic.qq.com/',
      ],
      streamUrlProbe,
    });
    const { result } = await login(harness.service, harness.emit);
    const token = result.cookie?.split('=')[1];

    await expect(
      harness.service.getMusicPlay(token, 'song-mid', 'flac', 'media-mid'),
    ).resolves.toEqual({
      'song-mid': {
        url: 'https://fast.stream.qqmusic.qq.com/fixture.flac',
        error: false,
        source: { kind: 'full', protocol: 'android-vkey', cdn: 'probed' },
      },
    });
    expect(streamUrlProbe).toHaveBeenCalledTimes(4);
    expect(streamUrlProbe).toHaveBeenNthCalledWith(
      1,
      'http://sjy6.stream.qqmusic.qq.com/fixture.flac',
    );
    expect(
      streamUrlProbe.mock.calls.filter(([url]) => url.includes('sjy6.stream.qqmusic.qq.com')),
    ).toHaveLength(1);
    const dispatchCall = jest
      .mocked(harness.httpPost)
      .mock.calls.find(([, payload]) => methodOf(payload) === 'GetCdnDispatch');
    expect(dictionaryOf(dictionaryOf(dictionaryOf(dispatchCall?.[1]).req_0).param)).toMatchObject({
      uid: '0',
      use_new_domain: 1,
      use_ipv6: 1,
    });
  });

  it('should clear auth and close QR listeners on logout', async () => {
    const authSessionRepository = createMemoryAuthSessionRepository();
    const harness = createProtocolHarness({ authSessionRepository });
    const { result } = await login(harness.service, harness.emit);
    const token = result.cookie?.split('=')[1];

    expect(authSessionRepository.load()).toEqual([expect.objectContaining({ token })]);

    await harness.service.logout(token);

    await expect(harness.service.getLoginStatus(token)).resolves.toBeNull();
    expect(authSessionRepository.load()).toEqual([]);
    expect(harness.wasClosed()).toBe(true);
  });

  it('should restore an authenticated session after the service is recreated', async () => {
    const authSessionRepository = createMemoryAuthSessionRepository();
    const first = createProtocolHarness({ authSessionRepository });
    const { result } = await login(first.service, first.emit);
    const token = result.cookie?.split('=')[1];

    // Recreating the service models an Electron app restart: the renderer still owns only this
    // opaque token, while the repository supplies the credential/device pair to the new process.
    const restarted = createProtocolHarness({ authSessionRepository });

    await expect(restarted.service.getLoginStatus(token)).resolves.toMatchObject({
      musicid: 123,
      nickname: '我的 QQ 账号',
    });
    expect(restarted.comms.at(-1)).toMatchObject({
      qq: '123',
      authst: 'credential-key',
      tmeLoginType: 6,
    });
  });

  it('should restore an authenticated session from an encrypted file after a restart', async () => {
    // The Docker case: a brand new process, nothing shared but the file on the volume. Without a
    // repository this deployment loses every login on restart, which is the whole point of S3.
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-auth-restart-'));
    try {
      const filePath = path.join(directory, 'sessions.json');
      const secret = 'a-deployment-secret';
      const first = createProtocolHarness({
        authSessionRepository: createFileAuthSessionRepository(filePath, secret),
      });
      const { result } = await login(first.service, first.emit);
      const token = result.cookie?.split('=')[1];

      const restarted = createProtocolHarness({
        authSessionRepository: createFileAuthSessionRepository(filePath, secret),
      });

      await expect(restarted.service.getLoginStatus(token)).resolves.toMatchObject({
        musicid: 123,
      });
      expect(fs.readFileSync(filePath, 'utf8')).not.toContain('credential-key');
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('should keep login working when the session repository cannot be read or written', async () => {
    // PR #2 behaviour 5: a locked keychain or a read-only volume degrades to in-process
    // behaviour. It must never be able to stop someone logging in.
    const spies = (['info', 'warn'] as const).map((level) =>
      jest.spyOn(logger, level).mockImplementation(() => undefined),
    );
    try {
      const harness = createProtocolHarness({
        authSessionRepository: {
          kind: 'file',
          load: () => {
            throw new Error('SessionCryptoError');
          },
          save: () => {
            throw new Error('EACCES');
          },
        },
      });

      const { result } = await login(harness.service, harness.emit);
      const token = result.cookie?.split('=')[1];

      await expect(harness.service.getLoginStatus(token)).resolves.toMatchObject({ musicid: 123 });
      const logged = JSON.stringify(spies.map((spy) => spy.mock.calls));
      expect(logged).toContain('qq-auth.auth-session.load-failed');
      expect(logged).toContain('qq-auth.auth-session.save-failed');
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it('should persist the next login after an unreadable one, so a rotated secret costs one scan', async () => {
    // Rotating `QQ_SESSION_SECRET` makes the existing file undecryptable. That must cost exactly
    // one re-scan, not leave persistence broken until someone deletes the volume by hand.
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    try {
      const saved: (readonly unknown[])[] = [];
      const harness = createProtocolHarness({
        authSessionRepository: {
          kind: 'file',
          load: () => {
            throw new Error('SessionCryptoError');
          },
          save: (sessions) => {
            saved.push(sessions);
          },
        },
      });

      const { result } = await login(harness.service, harness.emit);
      const token = result.cookie?.split('=')[1];

      expect(saved.at(-1)).toEqual([expect.objectContaining({ token })]);
    } finally {
      warn.mockRestore();
    }
  });

  it('should discard an expired persisted session during restart', async () => {
    let current = 1_000_000;
    const now = () => current;
    const authSessionRepository = createMemoryAuthSessionRepository();
    const first = createProtocolHarness({ authSessionRepository, now });
    const { result } = await login(first.service, first.emit);
    const token = result.cookie?.split('=')[1];

    current += 24 * 60 * 60 * 1000 + 1;
    const restarted = createProtocolHarness({ authSessionRepository, now });

    await expect(restarted.service.getLoginStatus(token)).resolves.toBeNull();
    expect(authSessionRepository.load()).toEqual([]);
  });

  it('should surface an explicit rejection when the upstream refuses the credential', async () => {
    for (const upstreamCode of [1000, 104401, 104400]) {
      const harness = createProtocolHarness({ postLoginUpstreamCode: upstreamCode });
      const { result } = await login(harness.service, harness.emit);
      const token = result.cookie?.split('=')[1];

      // 之前这里抛的是 QqProtocolError，控制器把它变成 500，客户端只能判成网络错误。
      await expect(harness.service.getUserDetail(token)).rejects.toBeInstanceOf(
        AuthCredentialRejectedError,
      );
      await expect(harness.service.getUserPlaylists(token)).rejects.toBeInstanceOf(
        AuthCredentialRejectedError,
      );
      await expect(harness.service.getUserDetail(token)).rejects.toMatchObject({
        httpStatus: 401,
        upstreamCode,
      });
    }
  });

  it('should report a rejected credential as signed out on the status route', async () => {
    const harness = createProtocolHarness({ postLoginUpstreamCode: 1000 });
    const { result } = await login(harness.service, harness.emit);
    const token = result.cookie?.split('=')[1];

    // `/login/status` 回 200 加空载荷，因此这里必须是 null 而不是抛错，也不能是那份凭证推导出来的
    // 假 profile——后者会让用户看起来还登录着，而其余路由全部失败。
    await expect(harness.service.getLoginStatus(token)).resolves.toBeNull();
  });

  it('should keep a non-rejection upstream failure as a server error', async () => {
    const harness = createProtocolHarness({ postLoginUpstreamCode: 50006 });
    const { result } = await login(harness.service, harness.emit);
    const token = result.cookie?.split('=')[1];

    // 只有那三个安全码算「凭证被拒」；其余上游失败保持原样，一次抖动不该把用户登出。
    await expect(harness.service.getUserDetail(token)).rejects.not.toBeInstanceOf(
      AuthCredentialRejectedError,
    );
    await expect(harness.service.getLoginStatus(token)).rejects.toBeTruthy();
  });

  it('should derive the session deadline from the upstream musickey lifetime', async () => {
    let current = 1_000_000_000_000;
    const now = () => current;
    const harness = createProtocolHarness({
      now,
      // 实测值：keyExpiresIn = 259200 秒 = 整三天。
      credentialLifetime: {
        musickeyCreateTime: Math.floor(current / 1000),
        keyExpiresIn: 259200,
      },
    });
    const { result } = await login(harness.service, harness.emit);
    const token = result.cookie?.split('=')[1];

    // 硬编的 24 小时早就到期了，跟着上游走的会话还活着——这正是用户不必每天重新扫码的原因。
    current += 24 * 60 * 60 * 1000 + 1;
    await expect(harness.service.getLoginStatus(token)).resolves.toMatchObject({ musicid: 123 });

    current += 2 * 24 * 60 * 60 * 1000;
    await expect(harness.service.getLoginStatus(token)).resolves.toBeNull();
  });

  it('should silently refresh a stored QQ credential and persist it under the same token', async () => {
    const current = 1_000_000_000_000;
    const token = 'stored-token';
    const authSessionRepository = createMemoryAuthSessionRepository([
      {
        token,
        credential: {
          musicid: 123,
          str_musicid: '123',
          musickey: 'credential-key',
          loginType: 6,
          refresh_token: 'refresh-token',
          refresh_key: 'refresh-key',
          musickeyCreateTime: Math.floor(current / 1000) - (259200 - 5 * 60 * 60),
          keyExpiresIn: 259200,
        },
        device: createAndroidDevice(),
        expiresAt: current + 5 * 60 * 60 * 1000,
      },
    ]);
    const harness = createProtocolHarness({ authSessionRepository, now: () => current });

    await expect(harness.service.getLoginStatus(token)).resolves.toMatchObject({ musicid: 123 });

    const refreshCall = jest.mocked(harness.httpPost).mock.calls.find(([, payload]) => {
      const request = dictionaryOf(dictionaryOf(payload).req_0);
      return request.method === 'Login' && dictionaryOf(request.param).loginMode === 2;
    });
    expect(refreshCall).toBeDefined();
    expect(dictionaryOf(dictionaryOf(refreshCall?.[1]).comm)).toMatchObject({
      authst: 'credential-key',
      tmeLoginType: 6,
    });
    expect(dictionaryOf(dictionaryOf(dictionaryOf(refreshCall?.[1]).req_0).param)).toMatchObject({
      str_musicid: '123',
      musickey: 'credential-key',
      refresh_token: 'refresh-token',
      refresh_key: 'refresh-key',
      loginMode: 2,
    });
    expect(authSessionRepository.load()).toEqual([
      expect.objectContaining({
        token,
        credential: expect.objectContaining({ musickey: 'qq-refreshed-key', loginType: 6 }),
      }),
    ]);
  });

  it('QQ 音乐 App 登的微信账号：静默续期按微信账号送，19 位 id 原样送字符串', async () => {
    // App 换到的凭证没有 openid、refresh_token，只有 refresh_key；musicid 是占位的 0。
    const current = 1_000_000_000_000;
    const token = 'stored-app-wechat-token';
    const authSessionRepository = createMemoryAuthSessionRepository([
      {
        token,
        credential: {
          musicid: 0,
          str_musicid: '1234567890123456789',
          musickey: 'app-wechat-key',
          loginType: 1,
          refresh_key: 'app-wechat-refresh-key',
          musickeyCreateTime: Math.floor(current / 1000) - (259200 - 5 * 60 * 60),
          keyExpiresIn: 259200,
        },
        device: createAndroidDevice(),
        expiresAt: current + 5 * 60 * 60 * 1000,
      },
    ]);
    const harness = createProtocolHarness({ authSessionRepository, now: () => current });

    await expect(harness.service.getLoginStatus(token)).resolves.not.toBeNull();

    const refreshCalls = jest.mocked(harness.httpPost).mock.calls.filter(([, payload]) => {
      const request = dictionaryOf(dictionaryOf(payload).req_0);
      return request.method === 'Login' && dictionaryOf(request.param).loginMode === 2;
    });
    expect(refreshCalls).toHaveLength(1);
    expect(dictionaryOf(dictionaryOf(refreshCalls[0]?.[1]).comm)).toMatchObject({
      authst: 'app-wechat-key',
      tmeLoginType: 1,
    });
    expect(
      dictionaryOf(dictionaryOf(dictionaryOf(refreshCalls[0]?.[1]).req_0).param),
    ).toMatchObject({
      openid: '',
      refresh_token: '',
      str_musicid: '1234567890123456789',
      musickey: 'app-wechat-key',
      refresh_key: 'app-wechat-refresh-key',
      loginMode: 2,
    });
    expect(authSessionRepository.load()).toEqual([
      expect.objectContaining({
        token,
        credential: expect.objectContaining({ musickey: 'wechat-refreshed-key', loginType: 1 }),
      }),
    ]);
  });

  it('should fall back to the previous fixed lifetime when the upstream omits the key timings', async () => {
    let current = 1_000_000_000_000;
    const now = () => current;
    const harness = createProtocolHarness({ now });
    const { result } = await login(harness.service, harness.emit);
    const token = result.cookie?.split('=')[1];

    current += 24 * 60 * 60 * 1000 - 1;
    await expect(harness.service.getLoginStatus(token)).resolves.toMatchObject({ musicid: 123 });

    current += 2;
    await expect(harness.service.getLoginStatus(token)).resolves.toBeNull();
  });

  it('should clamp an absurd upstream lifetime instead of minting an unbounded session', async () => {
    let current = 1_000_000_000_000;
    const now = () => current;
    const harness = createProtocolHarness({
      now,
      credentialLifetime: {
        musickeyCreateTime: Math.floor(current / 1000),
        keyExpiresIn: 365 * 24 * 60 * 60,
      },
    });
    const { result } = await login(harness.service, harness.emit);
    const token = result.cookie?.split('=')[1];

    current += 7 * 24 * 60 * 60 * 1000 + 1;
    await expect(harness.service.getLoginStatus(token)).resolves.toBeNull();
  });

  it('should reject malformed persisted credentials before they reach an upstream request', async () => {
    const save = jest.fn();
    const authSessionRepository: AuthSessionRepository = {
      kind: 'test-corrupt-state',
      load: () => [
        {
          token: 'opaque-token',
          credential: { musicid: 123, loginType: 6 },
          device: {},
          expiresAt: Date.now() + 60_000,
        },
      ],
      save,
    };

    const restarted = createProtocolHarness({ authSessionRepository });

    await expect(restarted.service.getLoginStatus('opaque-token')).resolves.toBeNull();
    expect(restarted.calls).toEqual([]);
    expect(save).toHaveBeenCalledWith([]);
  });

  it('should keep the current login usable when the persistence backend is unavailable', async () => {
    const authSessionRepository: AuthSessionRepository = {
      kind: 'test-unavailable-keychain',
      load: () => {
        throw new Error('keychain unavailable');
      },
      save: () => {
        throw new Error('keychain unavailable');
      },
    };
    const harness = createProtocolHarness({ authSessionRepository });
    const { result } = await login(harness.service, harness.emit);
    const token = result.cookie?.split('=')[1];

    // Persistence failure must not turn a successful upstream login into a failed login. The
    // session remains process-local and can be replaced by a new scan after restart.
    await expect(harness.service.getLoginStatus(token)).resolves.toMatchObject({ musicid: 123 });
  });

  it('should reuse the stored device context after a service restart', async () => {
    const deviceRepository = createMemoryDeviceContextRepository();
    const first = createProtocolHarness({ deviceRepository });
    await first.service.createSession();
    const stored = deviceRepository.load();

    const restarted = createProtocolHarness({ deviceRepository });
    await restarted.service.createSession();

    expect(first.calls).toContain('GetQimei');
    expect(restarted.calls).not.toContain('GetQimei');
    expect(restarted.calls).toContain('GetSession');
    expect(stored).toMatchObject({ qimei: QIMEI_16, qimei36: QIMEI_36, sessionSid: 'session-sid' });
    expect(restarted.comms[0]).toMatchObject({
      QIMEI: QIMEI_16,
      QIMEI36: QIMEI_36,
      aid: stored?.androidId,
      OpenUDID: stored?.openUdid,
      uid: '1234567890',
    });
  });

  it('should persist a valid q16/q36 bootstrap without storing login credentials', async () => {
    const harness = createProtocolHarness();
    await login(harness.service, harness.emit);

    const stored = harness.deviceRepository.load();

    expect(stored?.qimei).toHaveLength(36);
    expect(stored?.qimei36).toHaveLength(36);
    expect(stored?.qimeiSavedAt).toEqual(expect.any(Number));
    const serialized = JSON.stringify(stored);
    for (const secret of ['credential-key', 'mqtt-key', 'must-not-leak'])
      expect(serialized).not.toContain(secret);
  });

  it('should back off on a non-zero QIMEI code instead of repeating upstream calls', async () => {
    const harness = createProtocolHarness({
      qimei: () => response({ code: -30002, data: undefined }),
    });

    const failure = await harness.service.createSession().catch((error: unknown) => error);
    const repeated = await harness.service.createSession().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(QrLoginServiceError);
    expect(failure).toEqual(
      expect.objectContaining({ httpStatus: 502, retryAfterMs: 15000, upstreamCode: -30002 }),
    );
    expect(repeated).toEqual(expect.objectContaining({ httpStatus: 429 }));
    expect(harness.calls).toEqual(['GetQimei']);
    expect(harness.deviceRepository.load()?.qimei).toBeUndefined();
  });

  it('should keep QIMEI, credentials, and device identifiers out of the logs', async () => {
    const spies = (['info', 'warn', 'error'] as const).map((level) =>
      jest.spyOn(logger, level).mockImplementation(() => undefined),
    );
    try {
      const harness = createProtocolHarness();
      const { result } = await login(harness.service, harness.emit);
      const device = harness.deviceRepository.load();
      const failing = createProtocolHarness({
        qimei: () => response({ code: -30002, data: undefined }),
      });
      await failing.service.createSession().catch(() => undefined);

      const logged = JSON.stringify(spies.map((spy) => spy.mock.calls));
      for (const secret of [
        QIMEI_16,
        QIMEI_36,
        'credential-key',
        'mqtt-key',
        'must-not-leak',
        'qr-id',
        String(result.cookie),
        String(device?.androidId),
        String(device?.imei),
        String(device?.openUdid),
      ])
        expect(logged).not.toContain(secret);
      expect(logged).toContain('-30002');
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it('should translate timeout and unknown keys to expired code 800', async () => {
    const harness = createProtocolHarness();
    const key = await harness.service.createSession();
    await harness.service.createQr(key);
    harness.emit({ type: 'timeout', payload: null });

    expect(await harness.service.checkQr(key)).toMatchObject({
      code: 800,
      message: 'QR code expired',
    });
    expect(await harness.service.checkQr('missing')).toEqual({
      code: 800,
      message: 'QR code expired',
    });
  });
});

describe('QQ login channel routing', () => {
  const loginParamOf = (harness: ReturnType<typeof createProtocolHarness>) =>
    dictionaryOf(
      dictionaryOf(
        dictionaryOf(
          jest
            .mocked(harness.httpPost)
            .mock.calls.map((call) => call[1])
            .find((payload) => methodOf(payload) === 'Login'),
        ).req_0,
      ).param,
    );

  it('should default to the mobile QQ channel when no channel is requested', async () => {
    const harness = createProtocolHarness();
    const key = await harness.service.createSession();
    await harness.service.createQr(key);

    expect(harness.calls).toContain('CreateQRCode');
    expect(harness.wechatRequests).toHaveLength(0);
  });

  it('should route the canonical `qq` channel through the mobile QQ flow', async () => {
    const harness = createProtocolHarness();
    const key = await harness.service.createSession('qq');
    await harness.service.createQr(key);

    expect(harness.calls).toContain('CreateQRCode');
    expect(harness.wechatRequests).toHaveLength(0);
  });

  it('should accept the legacy `mobile` alias and normalize it to `qq`', async () => {
    const info = jest.spyOn(logger, 'info').mockImplementation(() => undefined);
    try {
      const harness = createProtocolHarness();
      const key = await harness.service.createSession('mobile');
      await harness.service.createQr(key);

      // 别名只活在入口：会话建立之后，日志与路由都只应该见到 canonical 值，`mobile` 不该再出现。
      const channels = info.mock.calls
        .filter(([event]) => String(event).startsWith('qq-auth.qr-'))
        .map(([, fields]) => dictionaryOf(fields).loginChannel);
      expect(channels).toEqual(['qq', 'qq']);
      expect(harness.calls).toContain('CreateQRCode');
      expect(harness.wechatRequests).toHaveLength(0);
    } finally {
      info.mockRestore();
    }
  });

  it('should log only the cookie names and login type number from the QQ MQTT payload', async () => {
    const info = jest.spyOn(logger, 'info').mockImplementation(() => undefined);
    try {
      const harness = createProtocolHarness();
      const key = await harness.service.createSession('qq');
      await harness.service.createQr(key);
      harness.emit({ type: 'scanned', payload: {} });
      harness.emit({
        type: 'cookies',
        payload: {
          cookies: {
            qqmusic_uin: { value: '123' },
            qqmusic_key: { value: 'private-mqtt-key' },
            qrcode_id: { value: 'private-qr-id' },
            qqmusic_key_at: { value: '1700000000' },
            tmeLoginType: { value: '2' },
            'bad name; private-value': { value: 'x' },
          },
          commConf: { domain: '.qq.com', path: '/', expires: 1 },
        },
      });
      await waitFor(async () => (await harness.service.checkQr(key)).code === 803);
      const events = info.mock.calls.filter(([event]) => event === 'qq-auth.qq-cookies');
      expect(events).toHaveLength(1);
      expect(events[0][1]).toEqual({
        loginChannel: 'qq',
        cookieNames: ['qqmusic_key', 'qqmusic_key_at', 'qqmusic_uin', 'qrcode_id', 'tmeLoginType'],
        tmeLoginType: 2,
        uinDigits: 3,
        hasCommConf: true,
      });
      const text = JSON.stringify(info.mock.calls);
      for (const secret of ['private-mqtt-key', 'private-qr-id', '1700000000', 'private-value'])
        expect(text).not.toContain(secret);
    } finally {
      info.mockRestore();
    }
  });

  it('should still log an empty name list when the QQ cookies payload is not an object', async () => {
    const info = jest.spyOn(logger, 'info').mockImplementation(() => undefined);
    try {
      const harness = createProtocolHarness();
      const key = await harness.service.createSession('qq');
      await harness.service.createQr(key);
      harness.emit({ type: 'cookies', payload: { cookies: 'not-an-object' } });
      await waitFor(async () => (await harness.service.checkQr(key)).code === 800);
      const events = info.mock.calls.filter(([event]) => event === 'qq-auth.qq-cookies');
      expect(events).toHaveLength(1);
      expect(events[0][1]).toEqual({ loginChannel: 'qq', cookieNames: [], hasCommConf: false });
    } finally {
      info.mockRestore();
    }
  });

  it('should reject a channel that is neither canonical nor a legacy alias', async () => {
    const harness = createProtocolHarness();

    const error = await harness.service
      .createSession('telepathy' as QrLoginChannel)
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(QrLoginServiceError);
    expect(error).toEqual(expect.objectContaining({ httpStatus: 400 }));
    expect(harness.calls).toEqual([]);
  });

  it('should drive the WeChat channel through the web QR flow and exchange the OAuth code', async () => {
    const harness = createProtocolHarness({ wechatStatuses: [wxStatusBody(408)] });
    const key = await harness.service.createSession('wechat');

    const imageUrl = await harness.service.createQr(key);
    expect(imageUrl).toMatch(/^data:image\/png;base64,/);
    expect(await harness.service.checkQr(key)).toMatchObject({ code: 801 });

    harness.pushWechatStatus(wxStatusBody(404));
    await waitFor(async () => (await harness.service.checkQr(key)).code === 802);
    harness.pushWechatStatus(wxStatusBody(405, WX_CODE));
    await waitFor(async () => (await harness.service.checkQr(key)).code === 803);

    // The WeChat exchange swaps an OAuth code, not the App channel's MQTT token.
    expect(loginParamOf(harness)).toEqual({ code: WX_CODE, strAppid: 'wx48db31d50e334801' });
    expect(harness.comms.find((comm) => comm.tmeLoginType !== undefined)).toMatchObject({
      tmeLoginType: 1,
    });
    expect(harness.calls).not.toContain('CreateQRCode');
  });

  it('should retain a WeChat scan after 408 and still exchange a later 405 with the existing session cookie', async () => {
    const info = jest.spyOn(logger, 'info').mockImplementation(() => undefined);
    try {
      const harness = createProtocolHarness({
        wechatStatuses: [wxStatusBody(404), wxStatusBody(408), wxStatusBody(405, WX_CODE)],
      });
      const key = await harness.service.createSession('wechat');
      await harness.service.createQr(key);
      await expect(harness.service.checkQr(key)).resolves.toEqual({
        code: 802,
        message: 'QR code scanned',
      });
      await expect(harness.service.checkQr(key)).resolves.toEqual({
        code: 802,
        message: 'QR code scanned',
      });
      const confirmed = await harness.service.checkQr(key);
      expect(confirmed).toEqual({
        code: 803,
        message: 'Authorization login successful',
        cookie: expect.stringMatching(/^qqmusic_session=/),
      });
      await expect(
        harness.service.getLoginStatus(confirmed.cookie?.split('=')[1]),
      ).resolves.toEqual(expect.any(Object));
      expect(loginParamOf(harness)).toEqual({ code: WX_CODE, strAppid: 'wx48db31d50e334801' });
      const diagnostics = info.mock.calls.filter(([name]) =>
        String(name).startsWith('qq-auth.wechat-'),
      );
      expect(diagnostics).toContainEqual([
        'qq-auth.wechat-poll',
        expect.objectContaining({ outcome: 'status', upstreamCode: 405 }),
      ]);
      expect(diagnostics).toContainEqual([
        'qq-auth.wechat-qr-check',
        expect.objectContaining({ apiCode: 803, state: 'confirmed' }),
      ]);
      const text = JSON.stringify(diagnostics);
      for (const secret of [key, WX_UUID, WX_CODE, confirmed.cookie ?? '', 'wechat-credential-key'])
        expect(text).not.toContain(secret);
    } finally {
      info.mockRestore();
    }
  });

  it('should carry the WeChat login type into later authenticated requests', async () => {
    const harness = createProtocolHarness();
    const key = await harness.service.createSession('wechat');
    await harness.service.createQr(key);
    await waitFor(async () => (await harness.service.checkQr(key)).code === 803);
    const token = (await harness.service.checkQr(key)).cookie?.split('=')[1];

    await harness.service.getUserPlaylists(token);

    // The upstream reply carried no loginType, so the channel default has to travel with it.
    expect(harness.comms.at(-1)).toMatchObject({ qq: '456', tmeLoginType: 1 });
  });

  it('should merge encrypted-UIN favorite playlists and load the built-in liked songs', async () => {
    const harness = createProtocolHarness();
    const key = await harness.service.createSession('wechat');
    await harness.service.createQr(key);
    await waitFor(async () => (await harness.service.checkQr(key)).code === 803);
    const token = (await harness.service.checkQr(key)).cookie?.split('=')[1];

    await expect(harness.service.getUserPlaylists(token)).resolves.toMatchObject({
      v_playlist: [
        { tid: 7, dirName: '我喜欢' },
        { id: 8, title: '收藏歌单', songnum: 3 },
      ],
      total: 2,
      bFinish: true,
    });
    await expect(harness.service.getUserLikedSongs(token, 0, 100)).resolves.toMatchObject({
      songlist: [{ id: 9, mid: 'liked-song-mid', name: '收藏歌曲' }],
      total_song_num: 1,
      hasmore: 0,
    });

    const favoriteCall = jest
      .mocked(harness.httpPost)
      .mock.calls.find(([, payload]) => methodOf(payload) === 'CgiGetPlaylistFavInfo');
    const likedCall = jest
      .mocked(harness.httpPost)
      .mock.calls.find(([, payload]) => methodOf(payload) === 'CgiGetDiss');
    expect(dictionaryOf(dictionaryOf(dictionaryOf(favoriteCall?.[1]).req_0).param)).toEqual({
      uin: 'wechat-encrypt-uin',
      offset: 0,
      size: 100,
    });
    expect(dictionaryOf(dictionaryOf(dictionaryOf(likedCall?.[1]).req_0).param)).toMatchObject({
      disstid: 0,
      dirid: 201,
      song_begin: 0,
      song_num: 100,
      enc_host_uin: 'wechat-encrypt-uin',
    });
  });

  it('should read an owned playlist through the credentialed CgiGetDiss with a bounded page', async () => {
    const harness = createProtocolHarness();
    const key = await harness.service.createSession('wechat');
    await harness.service.createQr(key);
    await waitFor(async () => (await harness.service.checkQr(key)).code === 803);
    const token = (await harness.service.checkQr(key)).cookie?.split('=')[1];

    await expect(harness.service.getOwnedPlaylistSongs(undefined, { dirid: 3 })).resolves.toBe(
      null,
    );
    await expect(
      harness.service.getOwnedPlaylistSongs(token, {
        disstid: '9776806348',
        dirid: 3,
        offset: 2.7,
        limit: 500,
      }),
    ).resolves.toMatchObject({ songlist: [{ id: 9 }], total_song_num: 1 });

    const call = jest
      .mocked(harness.httpPost)
      .mock.calls.find(([, payload]) => methodOf(payload) === 'CgiGetDiss');
    expect(dictionaryOf(dictionaryOf(call?.[1]).req_0)).toMatchObject({
      module: 'music.srfDissInfo.DissInfo',
      param: {
        disstid: 9776806348,
        dirid: 3,
        song_begin: 2,
        song_num: 100,
        enc_host_uin: 'wechat-encrypt-uin',
      },
    });
  });

  it('should read favourite albums over the profile-asset CGI with an inclusive range', async () => {
    const harness = createProtocolHarness();
    const { result } = await login(harness.service, harness.emit);
    const token = result.cookie?.split('=')[1];

    await expect(harness.service.getUserAlbums(token, 0, 20)).resolves.toMatchObject({
      albumlist: [{ albumid: 88971, albummid: '000MkMni19ClKG' }, { albumid: 88972 }],
      totalalbum: 2,
      has_more: 0,
    });

    const [config] = harness.favoriteAlbumRequests;
    expect(String(config.url)).toContain('fcg_get_profile_order_asset.fcg');
    expect(config.method).toBe('GET');
    // `ein` is the last index wanted, not a count: a 20-row page ends at 19.
    expect(dictionaryOf(config.params)).toMatchObject({
      reqtype: 2,
      userid: '123',
      sin: 0,
      ein: 19,
    });
    // The CGI only answers for a logged-in caller, so the credential has to ride along.
    const cookie = String(dictionaryOf(config.headers).Cookie);
    expect(cookie).toContain('qqmusic_uin=123');
    expect(cookie).toContain('qm_keyst=credential-key');
  });

  it('should page favourite albums and report whether more remain', async () => {
    const harness = createProtocolHarness();
    const { result } = await login(harness.service, harness.emit);
    const token = result.cookie?.split('=')[1];

    await expect(harness.service.getUserAlbums(token, 0, 1)).resolves.toMatchObject({
      albumlist: [{ albumid: 88971 }],
      totalalbum: 2,
      has_more: 1,
    });
    await expect(harness.service.getUserAlbums(token, 1, 1)).resolves.toMatchObject({
      albumlist: [{ albumid: 88972 }],
      has_more: 0,
    });

    // A one-row page is `sin === ein`, which only holds if the range really is inclusive.
    expect(dictionaryOf(harness.favoriteAlbumRequests[0]?.params)).toMatchObject({
      sin: 0,
      ein: 0,
    });
    expect(dictionaryOf(harness.favoriteAlbumRequests[1]?.params)).toMatchObject({
      sin: 1,
      ein: 1,
    });
  });

  it('should answer with an empty favourite-album collection instead of failing', async () => {
    const harness = createProtocolHarness({ favoriteAlbums: [] });
    const { result } = await login(harness.service, harness.emit);
    const token = result.cookie?.split('=')[1];

    await expect(harness.service.getUserAlbums(token, 0, 20)).resolves.toMatchObject({
      albumlist: [],
      totalalbum: 0,
    });
  });

  it('should read favourite albums for a WeChat credential too', async () => {
    const harness = createProtocolHarness();
    const key = await harness.service.createSession('wechat');
    await harness.service.createQr(key);
    await waitFor(async () => (await harness.service.checkQr(key)).code === 803);
    const token = (await harness.service.checkQr(key)).cookie?.split('=')[1];

    await expect(harness.service.getUserAlbums(token, 0, 20)).resolves.toMatchObject({
      totalalbum: 2,
    });
    // The WeChat channel carries its own account id; the CGI is addressed by that, not by a
    // QQ number, and its cookie has to be the WeChat-issued key.
    const [config] = harness.favoriteAlbumRequests;
    expect(dictionaryOf(config.params)).toMatchObject({ userid: '456' });
    expect(String(dictionaryOf(config.headers).Cookie)).toContain('qm_keyst=wechat-credential-key');
  });

  it('should surface a rejected favourite-album call instead of reporting an empty collection', async () => {
    // 4000 is what the CGI answers when it does not accept the caller as logged in. Reporting
    // that as "no favourites" would be indistinguishable from a genuinely empty collection.
    const harness = createProtocolHarness({ favoriteAlbumCode: 4000 });
    const { result } = await login(harness.service, harness.emit);
    const token = result.cookie?.split('=')[1];

    await expect(harness.service.getUserAlbums(token, 0, 20)).rejects.toThrow(
      /get-user-favorite-albums/,
    );
  });

  it('should not mistake an accepted-but-malformed favourite-album reply for a failure', async () => {
    // `code: 0` with no `data` at all. The call was accepted, so this must not throw the way a
    // rejection does; the route turns the empty result into an empty collection.
    const harness = createProtocolHarness({ favoriteAlbumBody: { code: 0 } });
    const { result } = await login(harness.service, harness.emit);
    const token = result.cookie?.split('=')[1];

    await expect(harness.service.getUserAlbums(token, 0, 20)).resolves.toEqual({});
  });

  it('should answer with null for an unknown token so the route can require a login', async () => {
    const harness = createProtocolHarness();
    await expect(harness.service.getUserAlbums('unknown-token', 0, 20)).resolves.toBeNull();
    expect(harness.favoriteAlbumRequests).toHaveLength(0);
  });

  it('should refresh a WeChat credential rejected with safe code 1000 before confirming', async () => {
    const harness = createProtocolHarness({ wechatNeedsRefresh: true });
    const key = await harness.service.createSession('wechat');
    await harness.service.createQr(key);
    await waitFor(async () => (await harness.service.checkQr(key)).code === 803);
    const token = (await harness.service.checkQr(key)).cookie?.split('=')[1];

    // 刷新过的凭证是可用的，因此这里走的是 GetLoginUserInfo 成功那条路，`musicid` 由上游的数字覆盖
    // 掉凭证推导出来的字符串——与其余成功用例一致。
    const profile = await harness.service.getLoginStatus(token);
    expect(profile).toMatchObject({
      musicid: 456,
      nickname: '我的微信账号',
    });
    for (const secret of [
      'musickey',
      'openid',
      'unionid',
      'refresh_token',
      'refresh_key',
      'access_token',
      'encryptUin',
    ])
      expect(profile).not.toHaveProperty(secret);

    const refreshCall = jest.mocked(harness.httpPost).mock.calls.find(([, payload]) => {
      const request = dictionaryOf(dictionaryOf(payload).req_0);
      return request.method === 'Login' && dictionaryOf(request.param).loginMode === 2;
    });
    expect(refreshCall).toBeDefined();
    expect(dictionaryOf(dictionaryOf(dictionaryOf(refreshCall?.[1]).req_0).param)).toMatchObject({
      openid: 'wechat-openid',
      refresh_token: 'wechat-refresh-token',
      str_musicid: '456',
      musickey: 'wechat-credential-key',
      unionid: 'wechat-unionid',
      refresh_key: 'wechat-refresh-key',
      loginMode: 2,
    });
    expect(dictionaryOf(dictionaryOf(refreshCall?.[1]).comm)).toMatchObject({
      authst: 'wechat-credential-key',
      tmeLoginType: 1,
    });
    expect(harness.comms.at(-1)).toMatchObject({
      authst: 'wechat-refreshed-key',
      tmeLoginType: 1,
    });
    const profileCalls = jest
      .mocked(harness.httpPost)
      .mock.calls.filter(([, payload]) => methodOf(payload) === 'GetLoginUserInfo');
    expect(dictionaryOf(profileCalls[0]?.[2]).headers).toEqual(
      expect.objectContaining({
        Cookie:
          'uin=456; qqmusic_uin=456; qm_keyst=wechat-credential-key; qqmusic_key=wechat-credential-key',
      }),
    );
    expect(dictionaryOf(profileCalls.at(-1)?.[2]).headers).toEqual(
      expect.objectContaining({
        Cookie:
          'uin=456; qqmusic_uin=456; qm_keyst=wechat-refreshed-key; qqmusic_key=wechat-refreshed-key',
      }),
    );
  });

  it('should keep the Android device context off the WeChat web endpoints', async () => {
    const harness = createProtocolHarness();
    const key = await harness.service.createSession('wechat');
    await harness.service.createQr(key);
    await waitFor(async () => (await harness.service.checkQr(key)).code === 803);

    const serialized = JSON.stringify(harness.wechatRequests);
    for (const leak of [QIMEI_16, QIMEI_36, 'comm', 'tmeLoginType', 'session-sid'])
      expect(serialized).not.toContain(leak);
    expect(harness.wechatRequests[0]).toMatchObject({ responseType: 'text' });
    expect(harness.wechatRequests[1]).toMatchObject({ responseType: 'arraybuffer' });
  });

  it('should map a refused WeChat QR to the expired code', async () => {
    const harness = createProtocolHarness({ wechatStatuses: [wxStatusBody(403)] });
    const key = await harness.service.createSession('wechat');
    await harness.service.createQr(key);

    await waitFor(async () => (await harness.service.checkQr(key)).code === 800);

    expect(await harness.service.checkQr(key)).toMatchObject({
      code: 800,
      message: 'QR code expired',
    });
    expect(harness.calls).not.toContain('Login');
  });

  it('should preserve an unrecognised WeChat status as an opaque upstream code', async () => {
    const harness = createProtocolHarness({ wechatStatuses: [wxStatusBody(500)] });
    const key = await harness.service.createSession('wechat');
    await harness.service.createQr(key);

    await waitFor(async () => (await harness.service.checkQr(key)).code === 800);

    expect(await harness.service.checkQr(key)).toEqual(
      expect.objectContaining({ code: 800, upstreamCode: 500, retryAfterMs: 15000 }),
    );
  });

  it('should keep the WeChat uuid and OAuth code out of the logs', async () => {
    const spies = (['info', 'warn', 'error'] as const).map((level) =>
      jest.spyOn(logger, level).mockImplementation(() => undefined),
    );
    try {
      const harness = createProtocolHarness();
      const key = await harness.service.createSession('wechat');
      await harness.service.createQr(key);
      await waitFor(async () => (await harness.service.checkQr(key)).code === 803);

      const logged = JSON.stringify(spies.map((spy) => spy.mock.calls));
      for (const secret of [WX_UUID, WX_CODE, 'wechat-credential-key'])
        expect(logged).not.toContain(secret);
      expect(logged).toContain('wechat');
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});

describe('QQ auth HTTP client', () => {
  it('should carry Set-Cookie values across a manual redirect', async () => {
    const requests: AxiosRequestConfig[] = [];
    const transport = {
      request: jest.fn(async (config: AxiosRequestConfig) => {
        requests.push(config);
        if (requests.length === 1)
          return response({}, 302, { location: '/next', 'set-cookie': ['sid=secret; Path=/'] });
        return response({ ok: true });
      }),
    } as unknown as AxiosInstance;
    const client = createAuthHttpClient(transport);

    const result = await client.post<{ ok: boolean }>('https://example.test/start', {
      hello: 'world',
    });

    expect(result.data).toEqual({ ok: true });
    expect(requests[1].url).toBe('https://example.test/next');
    expect(requests[1].method).toBe('GET');
    expect(requests[1].headers).toEqual(expect.objectContaining({ Cookie: 'sid=secret' }));
    expect(client.getCookieHeader()).toBe('sid=secret');
  });

  it('should merge request credentials with cookies already stored in the jar', async () => {
    const requests: AxiosRequestConfig[] = [];
    const transport = {
      request: jest.fn(async (config: AxiosRequestConfig) => {
        requests.push(config);
        return requests.length === 1
          ? response({}, 200, { 'set-cookie': ['sid=session-secret; Path=/'] })
          : response({ ok: true });
      }),
    } as unknown as AxiosInstance;
    const client = createAuthHttpClient(transport);

    await client.post('https://example.test/bootstrap', {});
    await client.post(
      'https://example.test/musicu',
      {},
      { headers: { Cookie: 'uin=123; qqmusic_uin=123' } },
    );

    expect(requests[1].headers).toEqual(
      expect.objectContaining({ Cookie: 'sid=session-secret; uin=123; qqmusic_uin=123' }),
    );
  });
});

// 扫码失败的两个可选字段：upstreamErrorKey 只在「哪个通道、哪一步、哪一层、哪个数字」都对得上登记表时才给；
// 手机 QQ 换凭证失败后会改用扫码票据再验证一次，primaryFailure 交出被这次回退盖掉的那一步。
// 原有的 code／failureStage／failureReason／upstreamCode／upstreamGlobalCode／retryAfterMs 一个都不变。
describe('QR login failure classification', () => {
  const MQTT_COOKIES = {
    cookies: { qqmusic_uin: { value: '123' }, qqmusic_key: { value: 'mqtt-key' } },
  };

  const failWechatLogin = async (harness: ReturnType<typeof createProtocolHarness>) => {
    const key = await harness.service.createSession('wechat');
    await harness.service.createQr(key);
    await waitFor(async () => (await harness.service.checkQr(key)).code === 800);
    return harness.service.checkQr(key);
  };

  const failQqLogin = async (harness: ReturnType<typeof createProtocolHarness>) => {
    const key = await harness.service.createSession();
    await harness.service.createQr(key);
    harness.emit({ type: 'cookies', payload: MQTT_COOKIES });
    await waitFor(async () => (await harness.service.checkQr(key)).code === 800);
    return harness.service.checkQr(key);
  };

  /** 新字段的读取方式：旧的类型里没有它们，旧客户端也照样读得到整个对象。 */
  const fieldOf = (result: unknown, field: string): unknown =>
    (result as Record<string, unknown> | undefined)?.[field];

  /** Folia 判断「二维码自然过期」的条件（只看这四个字段），用来确认新字段不影响它。 */
  const isFoliaNaturalExpiry = (result: Record<string, unknown>): boolean =>
    result.failureReason === 'qr-timeout' ||
    ['failureStage', 'failureReason', 'upstreamCode', 'retryAfterMs'].every(
      (field) => result[field] === undefined,
    );

  it('微信换凭证回 20279：多一个 auth.device-limit，其余字段和以前一样，也没有回退字段', async () => {
    const result = await failWechatLogin(createProtocolHarness({ exchangeCode: 20279 }));

    expect(result).toEqual({
      code: 800,
      message: 'QR login failed',
      retryAfterMs: 15000,
      failureStage: 'credential-exchange',
      failureReason: 'upstream-rejected',
      upstreamHttpStatus: 200,
      upstreamCode: 20279,
      upstreamGlobalCode: 0,
      upstreamSubCode: undefined,
      upstreamErrorKey: 'auth.device-limit',
      failureHint: { key: 'login.device-limit', message: expect.any(String) },
    });
    expect(isFoliaNaturalExpiry(result as unknown as Record<string, unknown>)).toBe(false);
  });

  it('20279 只是这次扫码失败：已经登录的会话照常可用，不会变成 401', async () => {
    let current = 1_000_000;
    const options: HarnessOptions = { now: () => current };
    const harness = createProtocolHarness(options);
    const { result } = await login(harness.service, harness.emit);
    const token = result.cookie?.split('=')[1];

    // 等上一张二维码过了 180 秒的寿命被清掉，再用另一个通道扫一次；登录会话本身还在有效期内。
    current += 181_000;
    options.exchangeCode = 20279;
    expect(fieldOf(await failWechatLogin(harness), 'upstreamErrorKey')).toBe('auth.device-limit');

    await expect(harness.service.getUserDetail(token)).resolves.toMatchObject({ musicid: 123 });
    await expect(harness.service.getLoginStatus(token)).resolves.not.toBeNull();
  });

  it('微信刷新凭证回 20279 也认得出来（同一个上游方法）', async () => {
    const result = await failWechatLogin(
      createProtocolHarness({ wechatNeedsRefresh: true, refreshCode: 20279 }),
    );

    expect(result).toMatchObject({
      code: 800,
      failureStage: 'credential-validation',
      upstreamCode: 20279,
      upstreamErrorKey: 'auth.device-limit',
    });
    expect(fieldOf(result, 'primaryFailure')).toBeUndefined();
  });

  it('手机 QQ 换凭证回 20279、回退验证回 1000：顶层照旧是 1000，被盖掉的 20279 放进 primaryFailure', async () => {
    const result = await failQqLogin(
      createProtocolHarness({ exchangeCode: 20279, loginUserCode: 1000 }),
    );

    expect(result).toMatchObject({
      code: 800,
      message: 'QR login failed',
      failureStage: 'credential-validation',
      failureReason: 'upstream-rejected',
      upstreamCode: 1000,
      retryAfterMs: 15000,
      primaryFailure: {
        failureStage: 'credential-exchange',
        failureReason: 'upstream-rejected',
        upstreamCode: 20279,
        upstreamErrorKey: 'auth.device-limit',
      },
      fallbackAttempted: true,
      failureHint: { key: 'login.device-limit', message: expect.any(String) },
    });
    expect(fieldOf(result, 'upstreamErrorKey')).toBeUndefined();
  });

  it('手机 QQ 的 50006 → 1000（实测见过的顺序）：交出 50006，但保持未知、不给 key', async () => {
    const result = await failQqLogin(
      createProtocolHarness({ exchangeCode: 50006, loginUserCode: 1000 }),
    );

    expect(result).toMatchObject({
      code: 800,
      upstreamCode: 1000,
      primaryFailure: {
        failureStage: 'credential-exchange',
        failureReason: 'upstream-rejected',
        upstreamCode: 50006,
      },
      fallbackAttempted: true,
      failureHint: { key: 'login.wrong-scan-app', message: expect.any(String) },
    });
    expect(fieldOf(result, 'upstreamErrorKey')).toBeUndefined();
    expect(fieldOf(fieldOf(result, 'primaryFailure'), 'upstreamErrorKey')).toBeUndefined();
  });

  it('冷却期间的 429 也带着 primaryFailure，前端在网页版也分得出设备超限', async () => {
    const harness = createProtocolHarness({ exchangeCode: 20279, loginUserCode: 1000 });
    await failQqLogin(harness);

    const blocked = await harness.service.createSession().catch((error: unknown) => error);
    expect(blocked).toMatchObject({
      httpStatus: 429,
      diagnostics: {
        failureReason: 'local-backoff',
        lastFailure: {
          upstreamCode: 1000,
          primaryFailure: { upstreamCode: 20279, upstreamErrorKey: 'auth.device-limit' },
          fallbackAttempted: true,
        },
      },
    });
  });

  it('回退验证成功就登录成功；之后别的失败不会带上那次的 primaryFailure', async () => {
    let current = 1_000_000;
    const options: HarnessOptions = { exchangeCode: 50006, now: () => current };
    const harness = createProtocolHarness(options);
    const key = await harness.service.createSession();
    await harness.service.createQr(key);
    harness.emit({ type: 'cookies', payload: MQTT_COOKIES });
    await waitFor(async () => (await harness.service.checkQr(key)).code === 803);

    current += 181_000;
    const next = await harness.service.createSession();
    await harness.service.createQr(next);
    harness.emit({ type: 'canceled', payload: null });
    const canceled = await harness.service.checkQr(next);
    expect(canceled).toMatchObject({ code: 800, failureReason: 'user-canceled' });
    expect(fieldOf(canceled, 'primaryFailure')).toBeUndefined();
    expect(fieldOf(canceled, 'fallbackAttempted')).toBeUndefined();
  });

  it('手机 QQ 换凭证说操作频繁（104604）时，即使回退把它盖掉也冷却 30 秒', async () => {
    const result = await failQqLogin(
      createProtocolHarness({ exchangeCode: 104604, loginUserCode: 1000 }),
    );

    expect(result).toMatchObject({
      code: 800,
      upstreamCode: 1000,
      retryAfterMs: 30000,
      primaryFailure: { upstreamCode: 104604, upstreamErrorKey: 'auth.rate-limited' },
      failureHint: { key: 'login.rate-limited', message: expect.any(String) },
    });
  });

  it('微信换凭证回 50006：保持未知', async () => {
    const result = await failWechatLogin(createProtocolHarness({ exchangeCode: 50006 }));

    expect(result).toMatchObject({ code: 800, upstreamCode: 50006 });
    expect(fieldOf(result, 'upstreamErrorKey')).toBeUndefined();
    expect(fieldOf(result, 'failureHint')).toBeUndefined();
  });

  it.each([
    [20277, 'auth.account-restricted'],
    [20278, 'auth.account-restricted'],
    [20450, 'auth.account-banned'],
    [20272, 'auth.account-binding'],
    [20274, 'auth.account-binding'],
    [20261, 'auth.login-rejected'],
    [104604, 'auth.rate-limited'],
  ])('微信换凭证回 %d → %s', async (code, key) => {
    const result = await failWechatLogin(createProtocolHarness({ exchangeCode: code }));
    expect(result).toMatchObject({ code: 800, upstreamCode: code, upstreamErrorKey: key });
  });

  it('网关层的 20279 不当成业务码', async () => {
    const result = await failWechatLogin(
      createProtocolHarness({ exchangeGlobalCode: 20279, exchangeCode: 0 }),
    );

    expect(result).toMatchObject({ code: 800, upstreamGlobalCode: 20279, upstreamCode: 0 });
    expect(fieldOf(result, 'upstreamErrorKey')).toBeUndefined();
  });

  it('上游 HTTP 失败时即使单项码是 20279 也不给 key', async () => {
    const result = await failWechatLogin(
      createProtocolHarness({ exchangeCode: 20279, exchangeHttpStatus: 503 }),
    );

    expect(result).toMatchObject({
      code: 800,
      failureReason: 'upstream-http-error',
      upstreamHttpStatus: 503,
      upstreamCode: 20279,
    });
    expect(fieldOf(result, 'upstreamErrorKey')).toBeUndefined();
  });

  it('手机上取消的 800 不带 key，也不带回退字段', async () => {
    const harness = createProtocolHarness();
    const key = await harness.service.createSession();
    await harness.service.createQr(key);
    harness.emit({ type: 'canceled', payload: null });

    const canceled = await harness.service.checkQr(key);
    expect(canceled).toMatchObject({ code: 800, failureReason: 'user-canceled' });
    for (const field of ['upstreamErrorKey', 'primaryFailure', 'fallbackAttempted', 'failureHint'])
      expect(fieldOf(canceled, field)).toBeUndefined();
  });

  it('还原回来的记录里，没登记的 key 和格式不对的回退字段一律丢掉', async () => {
    const now = Date.now();
    const base = {
      channel: 'qq' as const,
      state: 'failed' as const,
      createdAt: now,
      expiresAt: now + 60_000,
      failureStage: 'credential-validation' as const,
      failureReason: 'upstream-rejected' as const,
      upstreamCode: 1000,
      retryAfterMs: 15000,
    };
    const qrSessionRepository = createMemoryQrSessionRepository([
      {
        ...base,
        key: 'restored-valid',
        upstreamErrorKey: 'auth.device-limit',
        primaryFailure: {
          failureStage: 'credential-exchange',
          failureReason: 'upstream-rejected',
          upstreamCode: 20279,
          upstreamErrorKey: 'auth.device-limit',
        },
        fallbackAttempted: true,
      } as never,
      {
        ...base,
        key: 'restored-forged',
        upstreamErrorKey: 'auth.made-up',
        primaryFailure: {
          failureStage: 'not-a-stage',
          failureReason: 'not-a-reason',
          upstreamCode: '20279',
          upstreamErrorKey: 'auth.made-up',
          message: 'private upstream text',
        },
        fallbackAttempted: 'yes',
      } as never,
      { ...base, key: 'restored-unclassified', upstreamErrorKey: 'upstream.unclassified' } as never,
      { ...base, key: 'restored-not-object', primaryFailure: 'credential-exchange' } as never,
    ]);
    const service = createQrLoginService({ qrSessionRepository });

    expect(await service.checkQr('restored-valid')).toMatchObject({
      upstreamErrorKey: 'auth.device-limit',
      primaryFailure: { upstreamCode: 20279, upstreamErrorKey: 'auth.device-limit' },
      fallbackAttempted: true,
      failureHint: { key: 'login.device-limit', message: expect.any(String) },
    });
    const forged = await service.checkQr('restored-forged');
    expect(fieldOf(forged, 'failureHint')).toBeUndefined();
    expect(fieldOf(forged, 'upstreamErrorKey')).toBeUndefined();
    expect(fieldOf(forged, 'primaryFailure')).toBeUndefined();
    expect(fieldOf(forged, 'fallbackAttempted')).toBeUndefined();
    expect(
      fieldOf(await service.checkQr('restored-unclassified'), 'upstreamErrorKey'),
    ).toBeUndefined();
    expect(fieldOf(await service.checkQr('restored-not-object'), 'primaryFailure')).toBeUndefined();
  });
});

// QQ 音乐 App 扫码通道：二维码和手机 QQ 扫码是同一套，差别在换凭证时照回调给的账号类型。
describe('QQ 音乐 App 扫码通道 qqmusic', () => {
  type Harness = ReturnType<typeof createProtocolHarness>;

  const scan = async (
    harness: Harness,
    channel: 'qq' | 'qqmusic',
    loginType?: string,
    uin = '456',
  ) => {
    // 先按字符串传：通道型别加上 qqmusic 之前，这份用例也要能编译、在执行时失败。
    const key = await harness.service.createSession(
      channel as Parameters<Harness['service']['createSession']>[0],
    );
    await harness.service.createQr(key);
    harness.emit({ type: 'scanned', payload: {} });
    harness.emit({
      type: 'cookies',
      payload: {
        cookies: {
          qqmusic_uin: { value: uin },
          qqmusic_key: { value: 'mqtt-key' },
          ...(loginType === undefined ? {} : { tmeLoginType: { value: loginType } }),
        },
      },
    });
    await waitFor(async () => [800, 803].includes((await harness.service.checkQr(key)).code));
    return harness.service.checkQr(key);
  };

  /** 每次 musicu 请求的 comm，按方法挑出来（QIMEI 请求没有 comm，不在里面）。 */
  const commsOf = (harness: Harness, method: string) =>
    harness.calls
      .filter((call) => call !== 'GetQimei')
      .map((call, index) => ({ call, comm: harness.comms[index] }))
      .filter(({ call }) => call === method)
      .map(({ comm }) => comm);

  it('Node 宣告三个通道，qqmusic 排在最后', () => {
    const harness = createProtocolHarness();
    expect(harness.service.getCapabilities().channels).toEqual(['qq', 'wechat', 'qqmusic']);
  });

  it('App 登的是微信账号：和官方客户端一样 comm 送 6 换凭证，登录后按微信账号读写', async () => {
    const harness = createProtocolHarness({ wechatBoundApp: true });
    const result = await scan(harness, 'qqmusic', '1');

    expect(result.code).toBe(803);
    expect(commsOf(harness, 'Login').map((comm) => comm.tmeLoginType)).toEqual([6]);
    const token = result.cookie?.split('=')[1];
    // 账号 id 来自换到的凭证（微信账号的 musicid 是占位的 0，真正的 id 在 str_musicid）。
    await expect(harness.service.getLoginStatus(token)).resolves.toMatchObject({
      str_musicid: '456',
    });
    expect(commsOf(harness, 'GetLoginUserInfo').at(-1)).toMatchObject({ tmeLoginType: 1 });
  });

  it.each([
    { label: 'App 登的是 QQ 账号', loginType: '2' },
    { label: '回调没给账号类型', loginType: undefined },
  ])('$label：和手机 QQ 一样用 6 换凭证', async ({ loginType }) => {
    const harness = createProtocolHarness();
    const result = await scan(harness, 'qqmusic', loginType);

    expect(result.code).toBe(803);
    expect(commsOf(harness, 'Login').map((comm) => comm.tmeLoginType)).toEqual([6]);
  });

  it('手机 QQ 通道被微信账号的 App 扫到：照旧失败，提示改用 QQ 音乐 App 登录', async () => {
    // 微信账号的 id 是 19 位；手机 QQ 通道照 3.3.1 送数字，结果和以前一样。
    const harness = createProtocolHarness({ wechatBoundApp: true, appUin: '1234567890123456789' });
    const result = await scan(harness, 'qq', '1', '1234567890123456789');

    expect(result).toMatchObject({
      code: 800,
      primaryFailure: { failureStage: 'credential-exchange', upstreamCode: 50006 },
      fallbackAttempted: true,
      failureHint: { key: 'login.wrong-scan-app' },
    });
    expect(JSON.stringify(result)).toContain('QQ Music app login');
    expect(commsOf(harness, 'Login').map((comm) => comm.tmeLoginType)).toEqual([6]);
  });

  /** 每次 POST 实际送出去的请求体：字符串照原文，对象照原样。 */
  const sentBodies = (harness: Harness) =>
    jest.mocked(harness.httpPost).mock.calls.map(([, payload]) => payload);
  /** 换凭证（带 qrCodeID 的 Login）实际送出去的 param；字符串请求体解析后才比对其他字段。 */
  const exchangeParams = (harness: Harness) =>
    sentBodies(harness)
      .map((payload) => (typeof payload === 'string' ? JSON.parse(payload) : payload))
      .map((payload) => dictionaryOf(dictionaryOf(dictionaryOf(payload).req_0).param))
      .filter((param) => param.qrCodeID !== undefined);
  const exchangeBodies = (harness: Harness) =>
    sentBodies(harness).filter((payload) =>
      (typeof payload === 'string' ? payload : JSON.stringify(payload)).includes('qrCodeID'),
    );

  it('QQ 音乐 App 通道：19 位的微信账号 id 照官方客户端送不失真的整数字面量', async () => {
    const harness = createProtocolHarness({ wechatBoundApp: true, appUin: '1234567890123456789' });
    const result = await scan(harness, 'qqmusic', '1', '1234567890123456789');

    expect(result.code).toBe(803);
    const [body] = exchangeBodies(harness);
    expect(typeof body).toBe('string');
    expect(body).toContain('"musicid":1234567890123456789,');
    expect(commsOf(harness, 'Login').map((comm) => comm.tmeLoginType)).toEqual([6]);
    // 登录后照回包的账号类型（微信是 1）读写。
    await expect(
      harness.service.getLoginStatus(result.cookie?.split('=')[1]),
    ).resolves.toMatchObject({ str_musicid: '1234567890123456789' });
    expect(commsOf(harness, 'GetLoginUserInfo').at(-1)).toMatchObject({ tmeLoginType: 1 });
  });

  it('只有要送长整数的换凭证先序列化，其他请求照旧送对象', async () => {
    const harness = createProtocolHarness({ wechatBoundApp: true, appUin: '1234567890123456789' });
    await scan(harness, 'qqmusic', '1', '1234567890123456789');
    const bodies = sentBodies(harness);
    expect(bodies.filter((payload) => typeof payload === 'string')).toEqual(
      exchangeBodies(harness),
    );
    expect(bodies.filter((payload) => typeof payload !== 'string').length).toBeGreaterThan(0);
  });

  it('手机 QQ 通道：长 id 照 3.3.1 送数字（不改既有行为）', async () => {
    const harness = createProtocolHarness({ wechatBoundApp: true, appUin: '1234567890123456789' });
    await scan(harness, 'qq', '1', '1234567890123456789');
    expect(exchangeBodies(harness).every((payload) => typeof payload !== 'string')).toBe(true);
    expect(exchangeParams(harness).map((param) => typeof param.musicid)).toEqual(['number']);
  });

  it('安全整数范围内的 id 照旧送数字', async () => {
    const harness = createProtocolHarness();
    await scan(harness, 'qqmusic', '2', '456');
    expect(exchangeParams(harness).map((param) => param.musicid)).toEqual([456]);
    expect(exchangeBodies(harness).every((payload) => typeof payload !== 'string')).toBe(true);
  });

  it('qq-cookies 日志只多记账号 id 的位数，不记值', async () => {
    const info = jest.spyOn(logger, 'info').mockImplementation(() => undefined);
    try {
      await scan(
        createProtocolHarness({ wechatBoundApp: true, appUin: '1234567890123456789' }),
        'qqmusic',
        '1',
        '1234567890123456789',
      );
      const events = info.mock.calls.filter(([event]) => event === 'qq-auth.qq-cookies');
      expect(events[0][1]).toMatchObject({ uinDigits: 19 });
      expect(JSON.stringify(events)).not.toContain('1234567890123456789');
    } finally {
      info.mockRestore();
    }
  });

  it('qq-cookies 日志记的是实际的通道', async () => {
    const info = jest.spyOn(logger, 'info').mockImplementation(() => undefined);
    try {
      await scan(createProtocolHarness({ wechatBoundApp: true }), 'qqmusic', '1');
      const events = info.mock.calls.filter(([event]) => event === 'qq-auth.qq-cookies');
      expect(events).toHaveLength(1);
      expect(events[0][1]).toMatchObject({ loginChannel: 'qqmusic', tmeLoginType: 1 });
    } finally {
      info.mockRestore();
    }
  });
});
