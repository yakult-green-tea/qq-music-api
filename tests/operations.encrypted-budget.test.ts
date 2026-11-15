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
  const call = (token: string | undefined, quality: string) => {
    const req: OperationRequest = {
      runtime, method: 'GET', params: {}, token,
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
  afterEach(() => jest.restoreAllMocks());

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
});
