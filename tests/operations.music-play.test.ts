import './helpers/sessionRoutes';
import { userInfo } from '../src/config';
import musicPlayOperationController from '../src/controllers/musicPlayOperation';
import { getMusicPlay } from '../src/routes/operations/getMusicPlay';
import { CATALOG_RUNTIMES } from './helpers/catalogRoutes';
import { createParityRunner } from './helpers/operationParity';
import { useSessionUpstream } from './helpers/sessionRoutes';

const parity = createParityRunner(
  { name: 'getMusicPlay', node: '/getMusicPlay/:songmid?', serverless: '/getMusicPlay/:songmid?' },
  {
    operation: getMusicPlay,
    operationNode: musicPlayOperationController,
  },
);
const uuid = '00000000-0000-4000-8000-000000000001';

describe.each(CATALOG_RUNTIMES)('/getMusicPlay 共用处理与真实宿主契约（%s）', (runtime) => {
  const upstream = useSessionUpstream(runtime);
  beforeEach(() => jest.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(uuid));
  it.each([
    'valid',
    'missing',
    'invalid',
    'expired',
  ] as const)('会话 %s 保留认证和匿名分支', async (mode) => {
    const legs = await parity(
      runtime,
      '/getMusicPlay/fixture-song',
      upstream.calls,
      await upstream.options(mode),
    );
    const ok = mode === 'valid' || (mode === 'missing' && runtime === 'node');
    expect(legs.operation.status).toBe(ok ? 200 : 401);
    expect(legs.operation.body).toEqual(
      ok
        ? {
            data: {
              playUrl: {
                'fixture-song': {
                  url: 'https://stream.invalid/fixture.mp3',
                  error: false,
                  // 匿名分支没有 source；带会话的结果多一个可选的 source。
                  ...(mode === 'valid'
                    ? { source: { kind: 'full', protocol: 'android-vkey', cdn: 'response-sip' } }
                    : {}),
                },
              },
            },
          }
        : { code: 401, message: 'Login required' },
    );
    expect(legs.operation.calls).toHaveLength(ok ? 1 : 0);
    if (ok)
      expect(legs.operation.calls[0].rpc[0].method).toBe(
        mode === 'missing' ? 'CgiGetVkey' : 'UrlGetVkey',
      );
    expect(legs.host).toEqual(legs.operation);
  });
  it.each([
    { label: '凭证拒绝', businessCode: 1000, status: 401 },
    { label: '未知业务码', businessCode: 777777, status: 500 },
    { label: '2001', businessCode: 2001, status: 500 },
    { label: '网关失败', globalCode: 500003, status: 500 },
    {
      label: '网关与凭证码同时出现时网关优先',
      globalCode: 500003,
      businessCode: 1000,
      status: 502,
    },
    {
      label: '连线失败',
      networkError: Object.assign(new Error('fixture-private-message'), { code: 'ECONNRESET' }),
      status: 500,
    },
    { label: 'HTTP 503', httpStatus: 503, status: 500 },
  ])('$label', async ({ label: _label, status, ...state }) => {
    Object.assign(upstream.state, state);
    const legs = await parity(
      runtime,
      '/getMusicPlay/fixture-song',
      upstream.calls,
      await upstream.options(),
    );
    expect(legs.operation.status).toBe(status);
    expect(legs.operation.calls).toHaveLength(1);
    expect(JSON.stringify(legs.operation.body)).not.toContain('fixture-private');
    expect(legs.host).toEqual(legs.operation);
  });
  it.each([
    {},
    { sip: [], midurlinfo: [] },
    {
      sip: ['https://stream.invalid/'],
      midurlinfo: [{ songmid: 'fixture-song', purl: '', result: 104003 }],
    },
    {
      sip: ['https://stream.invalid/'],
      midurlinfo: [
        { songmid: 'fixture-a', purl: 'fixture.mp3' },
        { songmid: 'fixture-b', purl: '', errtype: 1 },
      ],
    },
  ])('保留空结果和逐曲失败 %j', async (data) => {
    upstream.state.data = data;
    const legs = await parity(
      runtime,
      '/getMusicPlay/fixture-a,fixture-b?resType=raw',
      upstream.calls,
      await upstream.options(),
    );
    expect(legs.operation.status).toBe(200);
    expect(legs.host).toEqual(legs.operation);
  });
  it.each([
    '',
    '?songmid=',
    '/%20',
    '?songmid=%20',
  ])('缺少 songmid %s 时先回 400', async (suffix) => {
    const legs = await parity(
      runtime,
      '/getMusicPlay' + suffix,
      upstream.calls,
      await upstream.options(),
    );
    expect(legs.operation.status).toBe(400);
    expect(legs.operation.body).toEqual({ data: { message: 'no songmid' } });
    expect(legs.operation.calls).toEqual([]);
    expect(legs.host).toEqual(legs.operation);
  });
  it.each([
    '?songmid=fixture-a&songmid=fixture-b',
    '?songmid=&songmid=fixture-b',
    '/fixture-song?songmid=fixture-other',
    '/%20fixture-song%20',
    '/fixture-a,%20fixture-b,,',
    '/fixture-song?quality=&mediaId=',
    '/fixture-song?quality=flac&quality=320',
    '/fixture-song?quality=&quality=320',
    '/fixture-song?mediaId=fixture-a&mediaId=fixture-b',
    '/fixture-song?mediaId=&mediaId=fixture-b',
    '/fixture-song?resType=raw',
    '/fixture-song?resType=play&resType=play',
    '/fixture-song?resType=&unused=&unused=b',
  ])('保留参数取法 %s', async (suffix) => {
    const legs = await parity(
      runtime,
      '/getMusicPlay' + suffix,
      upstream.calls,
      await upstream.options(),
    );
    expect(legs.operation.status).toBe(
      suffix.startsWith('?songmid=&') && runtime === 'serverless' ? 400 : 200,
    );
    expect(legs.host).toEqual(legs.operation);
  });
  it.each([
    'm4a',
    '128',
    '320',
    'ape',
    'flac',
    'invalid',
    '',
  ])('音质 %s 与 mediaId', async (quality) => {
    if (quality === 'ape')
      upstream.state.songDetails = { 'fixture-song': { file: { size_ape: 12 } } };
    const legs = await parity(
      runtime,
      '/getMusicPlay/fixture-song?quality=' + quality + '&mediaId=fixture-media',
      upstream.calls,
      await upstream.options(),
    );
    expect(legs.operation.status).toBe(200);
    const file = {
      m4a: 'C400fixture-songfixture-media.m4a',
      ape: 'A000fixture-songfixture-media.ape',
      flac: 'F000fixture-songfixture-media.flac',
      '320': 'M800fixture-songfixture-media.mp3',
    };
    expect(
      legs.operation.calls.flatMap((call) => call.rpc).find((rpc) => rpc.method === 'UrlGetVkey')
        ?.param.filename,
    ).toEqual([file[quality as keyof typeof file] ?? 'M500fixture-songfixture-media.mp3']);
    expect(legs.host).toEqual(legs.operation);
  });
  if (runtime === 'serverless')
    it('真正入口没设密钥仍先回 501', async () => {
      const options = await upstream.options();
      options.env = {};
      const legs = await parity(runtime, '/getMusicPlay/fixture-song', upstream.calls, options);
      expect(legs.host).toEqual({
        status: 501,
        body: {
          code: 501,
          message:
            'QQ_SESSION_SECRET is not set, so this deployment cannot hold a session. Catalog routes still work.',
        },
        calls: [],
      });
    });
  if (runtime === 'node') {
    it('匿名分支沿用 Node 当次配置的 uin', async () => {
      const original = userInfo.uin;
      try {
        userInfo.uin = 'fixture-config-uin';
        const legs = await parity(
          runtime,
          '/getMusicPlay/fixture-song',
          upstream.calls,
          await upstream.options('missing'),
        );
        expect(legs.operation.calls[0].rpc[0].param.uin).toBe('fixture-config-uin');
        expect(legs.host).toEqual(legs.operation);
      } finally {
        userInfo.uin = original;
      }
    });
    it.each(['network', 'http'] as const)('匿名播放 %s 失败保留 500', async (kind) => {
      if (kind === 'network')
        upstream.state.networkError = Object.assign(new Error('fixture-private-message'), {
          code: 'ECONNRESET',
        });
      else upstream.state.httpStatus = 503;
      const legs = await parity(
        runtime,
        '/getMusicPlay/fixture-song',
        upstream.calls,
        await upstream.options('missing'),
      );
      expect(legs.operation.status).toBe(500);
      expect(legs.host).toEqual(legs.operation);
    });
    it.each([
      '/fixture-song?resType=raw',
      '/fixture-song?resType=play&resType=play',
      '/fixture-song?quality=flac&quality=320&mediaId=a&mediaId=b',
      '?songmid=fixture-a&songmid=fixture-b',
      '/fixture-a,%20fixture-b,,',
      '/fixture-song?mediaId=',
    ])('匿名播放保留原始参数和完整回应 %s', async (suffix) => {
      const legs = await parity(
        runtime,
        '/getMusicPlay' + suffix,
        upstream.calls,
        await upstream.options('missing'),
      );
      expect(legs.operation.status).toBe(200);
      expect(legs.host).toEqual(legs.operation);
    });
    it.each([
      {},
      { req_0: { data: { sip: [], midurlinfo: [] } } },
      {
        req_0: {
          data: {
            sip: ['http://ws.fixture.invalid/'],
            midurlinfo: [{ songmid: 'fixture-song', purl: '' }],
          },
        },
      },
      {
        req_0: {
          data: {
            sip: ['http://ws.fixture.invalid/'],
            midurlinfo: [{ songmid: 'fixture-song', purl: 'fixture.mp3' }],
          },
        },
      },
      { req_0: { data: { sip: null, midurlinfo: [] } } },
      { req_0: { data: { sip: [], midurlinfo: null } } },
    ])('匿名回应字段边界 %j', async (body) => {
      upstream.state.anonymousPlay = body;
      const legs = await parity(
        runtime,
        '/getMusicPlay/fixture-song?resType=raw',
        upstream.calls,
        await upstream.options('missing'),
      );
      expect(legs.host).toEqual(legs.operation);
    });
  }
});
