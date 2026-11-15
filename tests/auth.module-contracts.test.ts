import { createMemoryDeviceContextRepository } from '../src/services/auth/deviceContext';
import type { AuthHttpClient } from '../src/services/auth/httpClient';
import { createMqttListenOver } from '../src/services/auth/mqtt';
import { QqProtocolError } from '../src/services/auth/musicuProtocol';
import { getAuthenticatedPlayUrls } from '../src/services/auth/playback';
import {
  createQrLoginService as createFromFacade,
  createMemoryAuthSessionRepository,
  QqProtocolError as FacadeProtocolError,
} from '../src/services/auth/qrLogin';
import { createQrLoginService } from '../src/services/auth/qrService';
import { createStoredSessionResolver } from '../src/services/auth/sessionState';
import deviceFixture from './fixtures/contracts/device-v1.json';
import { CONTRACT_CREDENTIAL, CONTRACT_NOW, CONTRACT_SONGS } from './helpers/contractUpstream';

// 模块拆分后旧入口、类身份和 Electron 使用的服务钩子仍要可用。
it('旧入口保留工厂与协议错误类身份', () => {
  expect(createFromFacade).toBe(createQrLoginService);
  expect(FacadeProtocolError).toBe(QqProtocolError);
  expect(new QqProtocolError('get-login-user', 1000, 0, 200)).toBeInstanceOf(FacadeProtocolError);
  expect(typeof createMqttListenOver).toBe('function');
});

it('服务模块保留登录、读取与 Electron 的私有兼容钩子', async () => {
  const http = {
    getCookieHeader: () => '',
    post: jest.fn(async () => ({
      data: { code: 0, req_0: { code: 0, data: { info: { nick: 'Fixture user' } } } },
      status: 200,
    })),
    request: jest.fn(),
  } as unknown as AuthHttpClient;
  const auth = {
    token: 'fixture-token',
    credential: CONTRACT_CREDENTIAL,
    device: deviceFixture.device,
    expiresAt: CONTRACT_NOW + 3600000,
  };
  const service = createQrLoginService({
    http,
    authSessionRepository: createMemoryAuthSessionRepository([auth]),
    deviceRepository: createMemoryDeviceContextRepository(deviceFixture.device),
    now: () => CONTRACT_NOW,
  });
  expect(service.getCapabilities()).toEqual({
    channels: ['qq', 'wechat', 'qqmusic'],
    sessionMode: 'stored',
  });
  expect(await service.getUserDetail(auth.token)).toMatchObject({ info: { nick: 'Fixture user' } });
  expect(typeof (service as unknown as { failSession: unknown }).failSession).toBe('function');
  expect(typeof (service as unknown as { failBootstrap: unknown }).failBootstrap).toBe('function');
  await service.logout(auth.token);
  expect(await service.getUserDetail(auth.token)).toBeNull();
});

it('拆出的 stored 会话沿用有效性检查和撤销', async () => {
  const repository = createMemoryAuthSessionRepository();
  const resolver = createStoredSessionResolver({
    repository,
    now: () => CONTRACT_NOW,
    randomBytes: (size: number) => Buffer.alloc(size, 3),
  });
  const token = await resolver.issue({
    credential: CONTRACT_CREDENTIAL,
    device: deviceFixture.device,
    expiresAt: CONTRACT_NOW + 1000,
  });
  expect((await resolver.resolve(token))?.credential).toEqual(CONTRACT_CREDENTIAL);
  await resolver.revoke(token);
  expect(await resolver.resolve(token)).toBeNull();
});

it('播放模块保留逐曲失败和原音质文件名', async () => {
  const post = jest.fn(async () => ({
    status: 200,
    data: {
      code: 0,
      req_0: {
        code: 0,
        data: {
          sip: ['https://stream.invalid/'],
          midurlinfo: [
            { songmid: CONTRACT_SONGS[0].mid, purl: 'fixture.flac' },
            { songmid: CONTRACT_SONGS[1].mid, purl: '', result: 104003 },
          ],
        },
      },
    },
  }));
  const auth = {
    token: 'fixture-token',
    credential: CONTRACT_CREDENTIAL,
    device: deviceFixture.device,
    expiresAt: CONTRACT_NOW + 1000,
  };
  const result = await getAuthenticatedPlayUrls(
    { post } as unknown as AuthHttpClient,
    auth,
    {} as Parameters<typeof getAuthenticatedPlayUrls>[2],
    `${CONTRACT_SONGS[0].mid},${CONTRACT_SONGS[1].mid}`,
    'flac',
    'fixture-media',
  );
  expect(result).toEqual({
    [CONTRACT_SONGS[0].mid]: {
      url: 'https://stream.invalid/fixture.flac',
      error: false,
      source: { kind: 'full', protocol: 'android-vkey', cdn: 'response-sip' },
    },
    [CONTRACT_SONGS[1].mid]: {
      url: '',
      error: '暂无播放链接',
      restriction: {
        key: 'url_unavailable',
        evidence: 'observed-response',
        codes: { result: 104003 },
        hint: { key: 'playback.reason-unconfirmed', message: expect.any(String) },
      },
      source: { kind: 'full', protocol: 'android-vkey', cdn: 'none' },
    },
  });
  // 原因还没有验证过的规则，不为挑提示多查单曲详情。
  expect(post).toHaveBeenCalledTimes(1);
  expect(
    (post.mock.calls[0] as unknown as [unknown, { req_0: { param: { filename: unknown } } }])[1]
      .req_0.param.filename,
  ).toEqual(CONTRACT_SONGS.slice(0, 2).map((song) => `F000${song.mid}fixture-media.flac`));
});
