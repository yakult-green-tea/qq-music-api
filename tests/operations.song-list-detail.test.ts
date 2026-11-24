import './helpers/sessionRoutes';
import { getSongListDetail } from '../src/routes/operations/getSongListDetail';
import { CATALOG_RUNTIMES } from './helpers/catalogRoutes';
import { createParityRunner } from './helpers/operationParity';
import { useSessionUpstream } from './helpers/sessionRoutes';

const parity = createParityRunner(
  {
    name: 'getSongListDetail',
    node: '/getSongListDetail/:disstid?',
    serverless: '/getSongListDetail/:disstid',
  },
  {
    operation: getSongListDetail,
  },
);
const unreadable = { code: 10, cdlist: [] };

describe.each(CATALOG_RUNTIMES)('/getSongListDetail 共用处理与真实宿主契约（%s）', (runtime) => {
  const upstream = useSessionUpstream(runtime);
  it.each([
    'valid',
    'missing',
    'invalid',
    'expired',
  ] as const)('匿名读成功时会话 %s 不触发重读', async (mode) => {
    const legs = await parity(
      runtime,
      '/getSongListDetail/70001',
      upstream.calls,
      await upstream.options(mode),
    );
    expect(legs.operation.status).toBe(200);
    expect(legs.operation.calls).toHaveLength(1);
    expect(legs.operation.body).toMatchObject({ response: { code: 0 } });
    expect(legs.host).toEqual(legs.operation);
  });
  it.each([
    'valid',
    'missing',
    'invalid',
    'expired',
  ] as const)('匿名 code 10 时会话 %s', async (mode) => {
    upstream.state.anonymousPlaylist = unreadable;
    const legs = await parity(
      runtime,
      '/getSongListDetail/70001',
      upstream.calls,
      await upstream.options(mode),
    );
    expect(legs.operation.status).toBe(200);
    expect(legs.operation.calls).toHaveLength(mode === 'valid' ? 2 : 1);
    if (mode === 'valid') {
      expect(legs.operation.body).toMatchObject({
        response: {
          code: 0,
          cdlist: [{ disstid: '70001', dissname: 'Fixture playlist', total_song_num: 1 }],
        },
      });
      expect(legs.operation.calls[1].rpc[0]).toMatchObject({
        method: 'uniform_get_Dissinfo',
        param: { disstid: 70001, song_begin: 0, song_num: 1000 },
      });
    } else expect(legs.operation.body).toEqual({ response: unreadable });
    expect(legs.host).toEqual(legs.operation);
  });
  it.each([
    { label: '凭证拒绝', businessCode: 1000 },
    { label: '未知业务码', businessCode: 777777 },
    { label: '2001', businessCode: 2001 },
    { label: '网关失败', globalCode: 500003 },
    { label: '网关与凭证码同时出现', globalCode: 500003, businessCode: 1000 },
    {
      label: '连线失败',
      networkError: Object.assign(new Error('fixture-private-message'), { code: 'ECONNRESET' }),
    },
    { label: 'HTTP 503', httpStatus: 503 },
    { label: '缺少歌单数据', data: {} },
    {
      label: '有效空歌单',
      data: { dirinfo: { id: 70001, title: 'Fixture playlist' }, songlist: [], total_song_num: 0 },
    },
  ])('重读$label 仍回匿名结果', async ({ label: _label, ...state }) => {
    Object.assign(upstream.state, state, { anonymousPlaylist: unreadable });
    const legs = await parity(
      runtime,
      '/getSongListDetail/70001',
      upstream.calls,
      await upstream.options(),
    );
    expect(legs.operation.status).toBe(200);
    expect(legs.operation.body).toEqual({ response: unreadable });
    expect(legs.operation.calls).toHaveLength(2);
    expect(legs.host).toEqual(legs.operation);
  });
  const privacyRejected = { code: 0, subcode: 4000, msg: 'check privacy error!' };
  const publicDissinfo = {
    code: 0,
    subcode: 0,
    dirinfo: {
      id: 70001,
      title: 'Public fixture',
      picurl: 'https://y.gtimg.cn/music/photo_new/T002R300x300M000fixtureCover.jpg',
      dir_show: 1,
      songnum: 1,
    },
    songlist: [{ mid: 'fixture-song', title: 'Fixture song' }],
    total_song_num: 1,
    hasmore: 0,
  };
  it.each([
    'valid',
    'missing',
  ] as const)('匿名 subcode 4000 时会话 %s 都改用匿名 musicu 读公开歌单', async (mode) => {
    upstream.state.anonymousPlaylist = privacyRejected;
    upstream.state.rpcReplies = { uniform_get_Dissinfo: { data: publicDissinfo } };
    const legs = await parity(
      runtime,
      '/getSongListDetail/70001',
      upstream.calls,
      await upstream.options(mode),
    );
    expect(legs.operation.status).toBe(200);
    expect(legs.operation.calls).toHaveLength(2);
    expect(legs.operation.calls[1].rpc[0]).toMatchObject({
      module: 'music.srfDissInfo.aiDissInfo',
      method: 'uniform_get_Dissinfo',
      param: { disstid: 70001, song_begin: 0, song_num: 1000, enc_host_uin: '' },
    });
    expect(legs.operation.calls[1].params).not.toHaveProperty('cookie');
    expect(legs.operation.body).toEqual({
      response: {
        code: 0,
        subcode: 0,
        cdnum: 1,
        realcdnum: 1,
        cdlist: [
          expect.objectContaining({
            disstid: '70001',
            dissname: 'Public fixture',
            logo: publicDissinfo.dirinfo.picurl,
            total_song_num: 1,
            hasmore: 0,
            songlist: publicDissinfo.songlist,
          }),
        ],
      },
    });
    expect(legs.host).toEqual(legs.operation);
  });
  it('匿名 subcode 4000、匿名改读被拒且没有会话：原样回 4000', async () => {
    upstream.state.anonymousPlaylist = privacyRejected;
    upstream.state.rpcReplies = { uniform_get_Dissinfo: { code: 80120, data: {} } };
    const legs = await parity(
      runtime,
      '/getSongListDetail/70001',
      upstream.calls,
      await upstream.options('missing'),
    );
    expect(legs.operation.status).toBe(200);
    expect(legs.operation.calls).toHaveLength(2);
    expect(legs.operation.body).toEqual({ response: privacyRejected });
    expect(legs.host).toEqual(legs.operation);
  });
  it('匿名 subcode 4000、匿名改读被拒但带着会话：再用凭据读', async () => {
    upstream.state.anonymousPlaylist = privacyRejected;
    upstream.state.rpcReplyQueues = {
      uniform_get_Dissinfo: [
        { code: 80120, data: {} },
        { data: publicDissinfo },
        { code: 80120, data: {} },
        { data: publicDissinfo },
      ],
    };
    const legs = await parity(
      runtime,
      '/getSongListDetail/70001',
      upstream.calls,
      await upstream.options('valid'),
    );
    expect(legs.operation.status).toBe(200);
    expect(legs.operation.calls).toHaveLength(3);
    expect(legs.operation.body).toMatchObject({
      response: { code: 0, cdlist: [{ disstid: '70001', dissname: 'Public fixture' }] },
    });
    expect(legs.host).toEqual(legs.operation);
  });
  it.each([10, '10', 2001, 777777, -1])('匿名业务码 %s 不改变 HTTP 状态', async (code) => {
    upstream.state.anonymousPlaylist = { code, cdlist: [] };
    const legs = await parity(
      runtime,
      '/getSongListDetail/70001',
      upstream.calls,
      await upstream.options('missing'),
    );
    expect(legs.operation.status).toBe(200);
    expect(legs.operation.body).toEqual({ response: { code, cdlist: [] } });
    expect(legs.host).toEqual(legs.operation);
  });
  it.each(['network', 'http'] as const)('匿名请求 %s 失败保留两边原有回包', async (kind) => {
    if (kind === 'network')
      upstream.state.networkError = Object.assign(new Error('fixture-private-message'), {
        code: 'ECONNRESET',
      });
    else upstream.state.httpStatus = 503;
    const legs = await parity(
      runtime,
      '/getSongListDetail/70001',
      upstream.calls,
      await upstream.options(),
    );
    const serverlessHttp = runtime === 'serverless' && kind === 'http';
    expect(legs.operation.status).toBe(serverlessHttp ? 200 : 500);
    expect(legs.operation.calls).toHaveLength(1);
    if (serverlessHttp) expect(legs.operation.body).toEqual({ response: 'fixture-private-body' });
    else expect(JSON.stringify(legs.operation.body)).not.toContain('fixture-private');
    expect(legs.host).toEqual(legs.operation);
  });
  it.each([
    '/70001?disstid=70002',
    '/0',
    '/invalid',
    '/%20',
    '/70001?unused=&unused=b',
  ])('路径参数 %s 与匿名参数隔离', async (suffix) => {
    upstream.state.anonymousPlaylist = unreadable;
    const legs = await parity(
      runtime,
      '/getSongListDetail' + suffix,
      upstream.calls,
      await upstream.options(),
    );
    expect(legs.operation.status).toBe(200);
    expect(legs.operation.calls[0].params).not.toHaveProperty('cookie');
    expect(legs.operation.calls[0].params).not.toHaveProperty('musickey');
    expect(legs.host).toEqual(legs.operation);
  });
  if (runtime === 'node')
    it.each([
      '',
      '?disstid=',
      '?disstid=70001',
      '?disstid=70001&disstid=70002',
      '?disstid=&disstid=70001',
    ])('保留 Node 查询形式 %s', async (query) => {
      upstream.state.anonymousPlaylist = unreadable;
      const legs = await parity(
        runtime,
        '/getSongListDetail' + query,
        upstream.calls,
        await upstream.options(),
      );
      expect(legs.operation.status).toBe(200);
      expect(legs.host).toEqual(legs.operation);
    });
  if (runtime === 'serverless')
    it.each([undefined, ''])('没设密钥 %s 时不建服务也不重读', async (secret) => {
      upstream.state.anonymousPlaylist = unreadable;
      const options = await upstream.options();
      options.env = { QQ_SESSION_SECRET: secret };
      const service = jest.fn(options.service);
      options.service = service;
      const legs = await parity(runtime, '/getSongListDetail/70001', upstream.calls, options);
      expect(legs.operation.status).toBe(200);
      expect(legs.operation.body).toEqual({ response: unreadable });
      expect(legs.operation.calls).toHaveLength(1);
      expect(service).not.toHaveBeenCalled();
      expect(legs.host).toEqual(legs.operation);
    });
});
