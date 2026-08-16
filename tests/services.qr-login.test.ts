import type { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import {
  createMemoryDeviceContextRepository,
  type DeviceContextRepository,
} from '../src/services/auth/deviceContext';
import createAuthHttpClient, { type AuthHttpClient } from '../src/services/auth/httpClient';
import {
  type AuthSessionRepository,
  createMemoryAuthSessionRepository,
  createQrLoginService,
  type QrLoginChannel,
  type QrLoginService,
  QrLoginServiceError,
} from '../src/services/auth/qrLogin';
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
  /** The exchanged WeChat key is rejected with safe code 1000 until refreshed. */
  wechatNeedsRefresh?: boolean;
  deviceRepository?: DeviceContextRepository;
  authSessionRepository?: AuthSessionRepository;
  now?: () => number;
  qimei?: () => AxiosResponse<unknown>;
  /** Reproduces the Android `UrlGetVkey` response, which carries `midurlinfo` but no `sip`. */
  emptyVkeySip?: boolean;
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
      payload?: unknown,
      _config?: AxiosRequestConfig,
    ): Promise<AxiosResponse<T>> => {
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
        return response({
          code: 0,
          req_0: { code: 0, data: { session: { uid: 1234567890, sid: 'session-sid' } } },
        } as T);
      }
      if (method === 'CreateQRCode') {
        const png = Buffer.from('89504e470d0a1a0a01020304', 'hex').toString('base64');
        return response({
          code: 0,
          req_0: { code: 0, data: { qrcodeID: 'qr-id', qrcode: png, expiresIn: 180 } },
        } as T);
      }
      if (method === 'Login' && options.failCredential) {
        return response({ code: 0, req_0: { code: 50006, data: {} } } as T);
      }
      if (method === 'Login') {
        const param = dictionaryOf(dictionaryOf(dictionaryOf(payload).req_0).param);
        if (param.loginMode === 2)
          return response({
            code: 0,
            req_0: {
              code: 0,
              data: {
                musicid: 456,
                str_musicid: '456',
                musickey: 'wechat-refreshed-key',
                openid: 'wechat-openid',
                refresh_token: 'wechat-refresh-token-2',
                refresh_key: 'wechat-refresh-key-2',
                unionid: 'wechat-unionid',
                encryptUin: 'wechat-encrypt-uin',
                nick: '我的微信账号',
              },
            },
          } as T);
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
  let closed = false;
  const wechat = createWechatHttpStub(options);
  const service = createQrLoginService({
    http,
    deviceRepository,
    authSessionRepository: options.authSessionRepository,
    createSessionHttp: () => wechat.client,
    // Must yield to the macrotask queue: an instantly resolved sleep would turn the poll loop
    // into a microtask chain that starves every timer in the test.
    sleep: () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
    now: options.now,
    randomBytes: (size) => Buffer.alloc(size, 7),
    listen: (_qrcodeId, onEvent) => {
      emit = onEvent;
      onEvent({ type: 'waiting', payload: null });
      return {
        ready: Promise.resolve(),
        done: new Promise<void>(() => undefined),
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
    wasClosed: () => closed,
  };
};

// Yields with a timer rather than setImmediate: the WeChat poll loop waits on setTimeout, and
// a setImmediate loop can burn 200 turns of the event loop without a millisecond of wall clock
// ever passing, so the poll would never get its turn.
const waitFor = async (predicate: () => boolean): Promise<void> => {
  for (let index = 0; index < 200; index += 1) {
    if (predicate()) return;
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
  await waitFor(() => service.checkQr(key).code === 803);
  return { key, imageUrl, result: service.checkQr(key) };
};

describe('QQ native QR login service', () => {
  it('should move through waiting, scanned, and confirmed states', async () => {
    const harness = createProtocolHarness();
    const key = await harness.service.createSession();
    const imageUrl = await harness.service.createQr(key);

    expect(imageUrl).toMatch(/^data:image\/png;base64,/);
    expect(harness.service.checkQr(key)).toMatchObject({ code: 801 });
    harness.emit({ type: 'scanned', payload: {} });
    expect(harness.service.checkQr(key)).toMatchObject({ code: 802 });
    harness.emit({
      type: 'cookies',
      payload: { cookies: { qqmusic_uin: { value: '123' }, qqmusic_key: { value: 'mqtt-key' } } },
    });
    await waitFor(() => harness.service.checkQr(key).code === 803);

    const confirmed = harness.service.checkQr(key);
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
    expect(harness.service.checkQr(key)).toMatchObject({ code: 800 });
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

    expect(harness.service.checkQr(key)).toMatchObject({ code: 803 });
  });

  it('should preserve upstream 50006 and apply a retry backoff', async () => {
    const harness = createProtocolHarness({ failCredential: true });
    const key = await harness.service.createSession();
    await harness.service.createQr(key);
    harness.emit({
      type: 'cookies',
      payload: { cookies: { qqmusic_uin: { value: '123' }, qqmusic_key: { value: 'mqtt-key' } } },
    });
    await waitFor(() => harness.service.checkQr(key).code === 800);

    expect(harness.service.checkQr(key)).toEqual(
      expect.objectContaining({
        code: 800,
        upstreamCode: 50006,
        retryAfterMs: 30000,
      }),
    );
    const retryError = await harness.service.createSession().catch((error: unknown) => error);
    expect(retryError).toBeInstanceOf(QrLoginServiceError);
    expect(retryError).toEqual(expect.objectContaining({ httpStatus: 429 }));
    expect((retryError as QrLoginServiceError).retryAfterMs).toBeGreaterThan(29000);
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
    await waitFor(() => harness.service.checkQr(key).code === 803);
    const token = harness.service.checkQr(key).cookie?.split('=')[1];

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
      'song-mid': { url: 'https://audio.example.test/fixture.flac', error: false },
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
      'song-mid': { url: 'http://dl.stream.qqmusic.qq.com/fixture.flac', error: false },
    });
  });

  it('should clear auth and close QR listeners on logout', async () => {
    const authSessionRepository = createMemoryAuthSessionRepository();
    const harness = createProtocolHarness({ authSessionRepository });
    const { result } = await login(harness.service, harness.emit);
    const token = result.cookie?.split('=')[1];

    expect(authSessionRepository.load()).toEqual([expect.objectContaining({ token })]);

    harness.service.logout(token);

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
      expect.objectContaining({ httpStatus: 502, retryAfterMs: 30000, upstreamCode: -30002 }),
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

    expect(harness.service.checkQr(key)).toMatchObject({ code: 800, message: 'QR code expired' });
    expect(harness.service.checkQr('missing')).toEqual({ code: 800, message: 'QR code expired' });
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

  it('should default to the QQ Music App channel when no channel is requested', async () => {
    const harness = createProtocolHarness();
    const key = await harness.service.createSession();
    await harness.service.createQr(key);

    expect(harness.calls).toContain('CreateQRCode');
    expect(harness.wechatRequests).toHaveLength(0);
  });

  it('should route the canonical `qq` channel through the QQ Music App flow', async () => {
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
    expect(harness.service.checkQr(key)).toMatchObject({ code: 801 });

    harness.pushWechatStatus(wxStatusBody(404));
    await waitFor(() => harness.service.checkQr(key).code === 802);
    harness.pushWechatStatus(wxStatusBody(405, WX_CODE));
    await waitFor(() => harness.service.checkQr(key).code === 803);

    // The WeChat exchange swaps an OAuth code, not the App channel's MQTT token.
    expect(loginParamOf(harness)).toEqual({ code: WX_CODE, strAppid: 'wx48db31d50e334801' });
    expect(harness.comms.find((comm) => comm.tmeLoginType !== undefined)).toMatchObject({
      tmeLoginType: 1,
    });
    expect(harness.calls).not.toContain('CreateQRCode');
  });

  it('should carry the WeChat login type into later authenticated requests', async () => {
    const harness = createProtocolHarness();
    const key = await harness.service.createSession('wechat');
    await harness.service.createQr(key);
    await waitFor(() => harness.service.checkQr(key).code === 803);
    const token = harness.service.checkQr(key).cookie?.split('=')[1];

    await harness.service.getUserPlaylists(token);

    // The upstream reply carried no loginType, so the channel default has to travel with it.
    expect(harness.comms.at(-1)).toMatchObject({ qq: '456', tmeLoginType: 1 });
  });

  it('should merge encrypted-UIN favorite playlists and load the built-in liked songs', async () => {
    const harness = createProtocolHarness();
    const key = await harness.service.createSession('wechat');
    await harness.service.createQr(key);
    await waitFor(() => harness.service.checkQr(key).code === 803);
    const token = harness.service.checkQr(key).cookie?.split('=')[1];

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
    await waitFor(() => harness.service.checkQr(key).code === 803);
    const token = harness.service.checkQr(key).cookie?.split('=')[1];

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
    await waitFor(() => harness.service.checkQr(key).code === 803);
    const token = harness.service.checkQr(key).cookie?.split('=')[1];

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
    await waitFor(() => harness.service.checkQr(key).code === 803);

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

    await waitFor(() => harness.service.checkQr(key).code === 800);

    expect(harness.service.checkQr(key)).toMatchObject({ code: 800, message: 'QR code expired' });
    expect(harness.calls).not.toContain('Login');
  });

  it('should preserve an unrecognised WeChat status as an opaque upstream code', async () => {
    const harness = createProtocolHarness({ wechatStatuses: [wxStatusBody(500)] });
    const key = await harness.service.createSession('wechat');
    await harness.service.createQr(key);

    await waitFor(() => harness.service.checkQr(key).code === 800);

    expect(harness.service.checkQr(key)).toEqual(
      expect.objectContaining({ code: 800, upstreamCode: 500, retryAfterMs: 30000 }),
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
      await waitFor(() => harness.service.checkQr(key).code === 803);

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
