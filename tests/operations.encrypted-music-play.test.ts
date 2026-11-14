import './helpers/sessionRoutes';
import { logger } from '../src/util/logger';
import { CATALOG_RUNTIMES, callRoute } from './helpers/catalogRoutes';
import { useSessionUpstream } from './helpers/sessionRoutes';

const mid = '0123456789abcd';
const media = 'abcdefghijklmn';
const route = '/getEncryptedMusicPlay';
const key = 'fixture-private-key';
const filename = (prefix = 'O6M0', extension = '.mgg') => prefix + mid + media + extension;
const purl = (prefix?: string, extension?: string) => `${filename(prefix, extension)}?vkey=fixture`;

describe.each(CATALOG_RUNTIMES)('加密取链接（%s）', (runtime) => {
  const upstream = useSessionUpstream(runtime);
  const call = async (
    query = '',
    session: 'valid' | 'missing' | 'invalid' = 'valid',
    path = route,
    method: 'GET' | 'HEAD' = 'GET',
  ) => {
    const { token, env } = await upstream.options(session);
    return callRoute(runtime, path + query, {
      env,
      method,
      headers: token ? { 'X-QQ-Session': token } : {},
      responseHeaders: ['cache-control'],
    });
  };
  const prepare = (reply: Record<string, unknown>) => {
    upstream.state.songDetails = { [mid]: { file: { media_mid: media } } };
    upstream.state.rpcReplies = { CgiGetEVkey: { data: reply } };
  };
  const rpcs = () => upstream.calls.flatMap(({ rpc }) => rpc);

  it.each([
    'missing',
    'invalid',
  ] as const)('没有有效会话（%s）回 401，不请求上游', async (session) => {
    expect(await call(`?songmid=${mid}&preview=1`, session)).toMatchObject({
      status: 401,
      headers: { 'cache-control': ['private, no-store'] },
    });
    expect(upstream.calls).toEqual([]);
  });

  it.each([
    '?preview=1',
    '?preview=true',
    '?preview=1&preview=0',
    '?quality=320',
    '?quality=best',
    '?quality=',
    '?quality=96&quality=192',
  ])('拒绝参数 %s，不请求上游', async (query) => {
    expect((await call(`${query}&songmid=${mid}`)).status).toBe(400);
    expect(upstream.calls).toEqual([]);
  });

  it('拒绝 HEAD，避免隐式触发取链接', async () => {
    expect((await call(`?songmid=${mid}`, 'valid', route, 'HEAD')).status).toBe(405);
    expect(upstream.calls).toEqual([]);
  });

  it.each([
    ['', '192', 'O6M0', '.mgg', 'mgg'],
    ['&quality=96', '96', 'O4M0', '.mgg', 'mgg'],
    ['&quality=flac', 'flac', 'F0M0', '.mflac', 'mflac'],
  ])('返回正确格式和 ekey（%s）', async (query, quality, prefix, extension, codec) => {
    const path = purl(prefix, extension);
    prepare({ midurlinfo: [{ songmid: mid, purl: path, ekey: key, result: 0 }] });
    expect(await call(`?songmid=${mid}${query}`)).toEqual({
      status: 200,
      body: {
        data: {
          playUrl: {
            [mid]: {
              url: `http://sjy6.stream.qqmusic.qq.com/${path}`,
              error: false,
              source: {
                kind: 'full',
                protocol: 'encrypted-evkey',
                cdn: 'unverified-default',
                encryption: 'encrypted',
                codec,
                quality,
                ekey: key,
              },
            },
          },
        },
      },
      headers: { 'cache-control': ['private, no-store'] },
    });
    expect(rpcs().map((rpc) => rpc.method)).toEqual(['get_song_detail_yqq', 'CgiGetEVkey']);
    expect(rpcs()[1]).toMatchObject({
      module: 'music.vkey.GetEVkey',
      param: { songmid: [mid], filename: [filename(prefix, extension)], songtype: [0], ctx: 0 },
    });
  });

  it.each([
    { result: 104003 },
    { result: undefined },
    { songmid: 'fixture-foreign' },
    { purl: purl('O4M0') },
    { purl: filename().replace(media, mid) },
    { purl: `//external.invalid/${filename()}` },
    { ekey: '' },
  ])('不交付未确认的条目（%j）', async (difference) => {
    prepare({ midurlinfo: [{ songmid: mid, purl: purl(), result: 0, ekey: key, ...difference }] });
    const reply = await call(`?songmid=${mid}`);
    expect(reply).toMatchObject({
      status: 200,
      body: {
        data: {
          playUrl: {
            [mid]: {
              url: '',
              error: '暂无播放链接',
              restriction: { hint: { key: 'playback.reason-unconfirmed' } },
            },
          },
        },
      },
    });
    expect(JSON.stringify(reply)).not.toContain(key);
    expect(rpcs().map((rpc) => rpc.method)).toEqual(['get_song_detail_yqq', 'CgiGetEVkey']);
  });

  it('没有可信 media_mid 就不猜文件名', async () => {
    prepare({});
    upstream.state.songDetails = {};
    expect((await call(`?songmid=${mid}`)).status).toBe(200);
    expect(rpcs().map((rpc) => rpc.method)).toEqual(['get_song_detail_yqq']);
  });

  it('单曲拒绝保留安全数字，日志不写地址、歌曲标识或密钥', async () => {
    prepare({
      midurlinfo: [{ songmid: mid, purl: purl(), result: 104003, subcode: 1, ekey: key }],
    });
    const debug = jest.spyOn(logger, 'debug').mockImplementation(() => undefined);
    const reply = await call(`?songmid=${mid}`);
    expect(reply.body).toMatchObject({
      data: {
        playUrl: {
          [mid]: {
            restriction: { codes: { result: 104003, subcode: 1 } },
          },
        },
      },
    });
    const lines = debug.mock.calls.filter(([event]) => event === 'playback.url-unavailable');
    expect(lines).toHaveLength(1);
    for (const sensitive of [mid, purl(), key])
      expect(JSON.stringify(lines)).not.toContain(sensitive);
  });

  it.each([
    [1000, 0, 401, 'auth-missing'],
    [1000, 55, 502, 'upstream-gateway'],
    [104003, 0, 502, 'upstream-business'],
  ])('请求级错误 (%s, %s) 保持会话语义', async (code, globalCode, status, kind) => {
    upstream.state.globalCode = globalCode;
    upstream.state.rpcReplies = { get_song_detail_yqq: { code } };
    expect(await call(`?songmid=${mid}`)).toMatchObject({
      status,
      body: { kind },
      headers: { 'cache-control': ['private, no-store'] },
    });
    expect(rpcs().map((rpc) => rpc.method)).toEqual(['get_song_detail_yqq']);
  });

  it('普通播放仍走 VKey，不解析意外的加密文件或交出 ekey', async () => {
    upstream.state.data = {
      sip: ['https://stream.invalid/'],
      midurlinfo: [{ songmid: mid, purl: purl(), ekey: key, result: 0 }],
    };
    const reply = await call(`?songmid=${mid}&encrypted=1`, 'valid', '/getMusicPlay');
    expect(reply).toMatchObject({
      status: 200,
      body: {
        data: {
          playUrl: {
            [mid]: {
              url: `https://stream.invalid/${purl()}`,
              source: { protocol: 'android-vkey' },
            },
          },
        },
      },
    });
    expect(JSON.stringify(reply)).not.toMatch(/ekey|mgg.*codec|encrypted-evkey/);
    expect(rpcs().map((rpc) => rpc.method)).toEqual(['UrlGetVkey']);
  });
});
