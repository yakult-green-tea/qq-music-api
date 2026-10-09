const mockYCommon = jest.fn();

jest.mock('../src/services/y_common', () => ({
  __esModule: true,
  default: mockYCommon,
}));

jest.mock('../src/util/logger', () => ({
  __esModule: true,
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

import songListDetail from '../src/services/songLists/songListDetail';
import { logger } from '../src/util/logger';

const mockedLogger = logger as jest.Mocked<typeof logger>;

describe('services/songListDetail', () => {
  beforeEach(() => {
    mockYCommon.mockReset();
    jest.clearAllMocks();
  });

  it('应在成功时返回标准响应并记录请求/成功日志', async () => {
    mockYCommon.mockResolvedValue({
      data: {
        cdlist: [{ disstid: '7011264340' }],
      },
    });

    const result = await songListDetail({
      params: {
        disstid: '7011264340',
      },
    });

    expect(mockYCommon).toHaveBeenCalledWith({
      url: '/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg',
      method: 'get',
      options: {
        params: {
          disstid: '7011264340',
          format: 'json',
          outCharset: 'utf-8',
          type: 1,
          json: 1,
          utf8: 1,
          onlysong: 0,
          new_format: 1,
        },
      },
    });
    expect(result).toEqual({
      status: 200,
      body: {
        response: {
          cdlist: [{ disstid: '7011264340' }],
        },
      },
    });
    expect(mockedLogger.info).toHaveBeenCalledWith(
      'service.requesting',
      expect.objectContaining({
        service: 'songListDetail',
      }),
    );
    expect(mockedLogger.info).toHaveBeenCalledWith(
      'service.succeeded',
      expect.objectContaining({
        service: 'songListDetail',
        disstid: '7011264340',
      }),
    );
  });

  it('应在底层请求失败时返回 500 并记录失败日志', async () => {
    const error = new Error('song list detail failed');
    mockYCommon.mockRejectedValue(error);

    const result = await songListDetail({});

    expect(result).toEqual({
      status: 500,
      body: {
        error,
      },
    });
    expect(mockedLogger.error).toHaveBeenCalledWith(
      'service.failed',
      expect.objectContaining({
        service: 'songListDetail',
        error: {
          name: 'Error',
          message: 'song list detail failed',
        },
      }),
    );
  });
});

// 匿名 CGI 读不到 QQ 音乐的算法歌单（百万收藏、歌手漫游……），只回 `code: 10`。这时如果请求带着登录
// 会话，就改用凭据重读一次，并改写成匿名 CGI 的形状；其余任何情况都必须与原来逐字相同。
describe('services/songListDetail：code 10 时用凭据重读', () => {
  const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
  const COVER_211192 =
    'https://y.gtimg.cn/music/photo_new/T002R300x300M000000FixAlbum001.jpg?max_age=2592000';
  const fcgCode10 = () => clone(require('./fixtures/official-playlists/fcg-code-10.json'));
  const dissData211192 = () =>
    clone(require('./fixtures/official-playlists/ai-dissinfo-211192.json').req_0.data);
  const publicPlaylist = {
    code: 0,
    cdlist: [{ disstid: '7011264340', dissname: '公开歌单', songlist: [{ mid: 'a' }] }],
  };
  const emptyShell = { code: 0, cdlist: [{ disstid: '9777066643', songlist: [] }] };

  const fcgParams = (disstid: string) => ({
    disstid,
    format: 'json',
    outCharset: 'utf-8',
    type: 1,
    json: 1,
    utf8: 1,
    onlysong: 0,
    new_format: 1,
  });

  beforeEach(() => {
    mockYCommon.mockReset();
    jest.clearAllMocks();
  });

  it.each([
    ['公开歌单（code 0）', publicPlaylist],
    ['不公开歌单的空壳（code 0）', emptyShell],
    ['参数不合法（code -1）', { code: -1, cdlist: [] }],
  ])('%s：原样返回，带着会话也不重读', async (_label, upstream) => {
    mockYCommon.mockResolvedValue({ data: clone(upstream) });
    const readWithCredential = jest.fn();

    const result = await songListDetail({
      params: { disstid: '7011264340' },
      readWithCredential,
    });

    expect(result).toEqual({ status: 200, body: { response: upstream } });
    expect(readWithCredential).not.toHaveBeenCalled();
  });

  it('code 10 但请求没带会话：原样返回 code 10', async () => {
    mockYCommon.mockResolvedValue({ data: fcgCode10() });

    const result = await songListDetail({ params: { disstid: '211192' } });

    expect(result).toEqual({ status: 200, body: { response: fcgCode10() } });
  });

  it('code 10 且带着会话：改用凭据重读，并改写成匿名 CGI 的形状', async () => {
    mockYCommon.mockResolvedValue({ data: fcgCode10() });
    const readWithCredential = jest.fn().mockResolvedValue(dissData211192());

    const result = await songListDetail({
      params: { disstid: '211192' },
      readWithCredential,
    });

    expect(readWithCredential).toHaveBeenCalledTimes(1);
    expect(readWithCredential).toHaveBeenCalledWith('211192');
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      response: {
        code: 0,
        subcode: 0,
        cdnum: 1,
        realcdnum: 1,
        cdlist: [
          expect.objectContaining({
            disstid: '211192',
            dissname: '歌手漫游 | 专享歌手Mix',
            logo: COVER_211192,
            total_song_num: 50,
            songlist: dissData211192().songlist,
          }),
        ],
      },
    });
    expect(mockedLogger.info).toHaveBeenCalledWith(
      'service.succeeded',
      expect.objectContaining({
        service: 'songListDetail',
        disstid: '211192',
        source: 'credential-fallback',
      }),
    );
  });

  it('送给匿名 CGI 的参数与没有重读能力时逐字相同', async () => {
    mockYCommon.mockResolvedValue({ data: fcgCode10() });

    await songListDetail({
      params: { disstid: '211192' },
      readWithCredential: jest.fn().mockResolvedValue(dissData211192()),
    });

    expect(mockYCommon).toHaveBeenCalledTimes(1);
    expect(mockYCommon).toHaveBeenCalledWith({
      url: '/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg',
      method: 'get',
      options: { params: fcgParams('211192') },
    });
  });

  it('会话无效（重读返回 null）：原样返回 code 10', async () => {
    mockYCommon.mockResolvedValue({ data: fcgCode10() });

    const result = await songListDetail({
      params: { disstid: '211192' },
      readWithCredential: jest.fn().mockResolvedValue(null),
    });

    expect(result).toEqual({ status: 200, body: { response: fcgCode10() } });
  });

  it.each([
    [
      '上游协议错误',
      Object.assign(new Error('failed'), { name: 'QqProtocolError', upstreamCode: 10004 }),
    ],
    ['凭据被拒', Object.assign(new Error('rejected'), { name: 'AuthCredentialRejectedError' })],
    ['网络错误', new Error('socket hang up')],
    ['不是 Error 的抛出值', 'boom'],
  ])('重读失败（%s）：原样返回 code 10，状态码仍是 200，绝不回 401', async (_label, failure) => {
    mockYCommon.mockResolvedValue({ data: fcgCode10() });

    const result = await songListDetail({
      params: { disstid: '211192' },
      readWithCredential: jest.fn().mockRejectedValue(failure),
    });

    expect(result).toEqual({ status: 200, body: { response: fcgCode10() } });
    expect(mockedLogger.warn).toHaveBeenCalledWith(
      'service.credential_fallback_failed',
      expect.objectContaining({ service: 'songListDetail', disstid: '211192' }),
    );
  });

  it('重读失败的日志只带错误类型与上游码', async () => {
    mockYCommon.mockResolvedValue({ data: fcgCode10() });

    await songListDetail({
      params: { disstid: '211192' },
      readWithCredential: jest.fn().mockRejectedValue(
        Object.assign(new Error('qm_keyst=secret'), {
          name: 'QqProtocolError',
          upstreamCode: 10004,
        }),
      ),
    });

    expect(mockedLogger.warn).toHaveBeenCalledWith('service.credential_fallback_failed', {
      service: 'songListDetail',
      disstid: '211192',
      name: 'QqProtocolError',
      upstreamCode: 10004,
    });
    expect(JSON.stringify(mockedLogger.warn.mock.calls)).not.toContain('secret');
  });

  it('重读到的歌单缺标题或没有歌：原样返回 code 10', async () => {
    mockYCommon.mockResolvedValue({ data: fcgCode10() });
    const untitled = dissData211192();
    untitled.dirinfo.title = '';

    const result = await songListDetail({
      params: { disstid: '211192' },
      readWithCredential: jest.fn().mockResolvedValue(untitled),
    });

    expect(result).toEqual({ status: 200, body: { response: fcgCode10() } });
  });

  it('code 10 但没有 disstid：不重读', async () => {
    mockYCommon.mockResolvedValue({ data: fcgCode10() });
    const readWithCredential = jest.fn();

    const result = await songListDetail({ params: {}, readWithCredential });

    expect(result).toEqual({ status: 200, body: { response: fcgCode10() } });
    expect(readWithCredential).not.toHaveBeenCalled();
  });

  it('匿名 CGI 本身失败：走原来的 500，不重读', async () => {
    const error = new Error('song list detail failed');
    mockYCommon.mockRejectedValue(error);
    const readWithCredential = jest.fn();

    const result = await songListDetail({ params: { disstid: '211192' }, readWithCredential });

    expect(result).toEqual({ status: 500, body: { error } });
    expect(readWithCredential).not.toHaveBeenCalled();
  });

  it('匿名 CGI 回应不是对象：原样返回，不重读', async () => {
    mockYCommon.mockResolvedValue({ data: 'not json' });
    const readWithCredential = jest.fn();

    const result = await songListDetail({ params: { disstid: '211192' }, readWithCredential });

    expect(result).toEqual({ status: 200, body: { response: 'not json' } });
    expect(readWithCredential).not.toHaveBeenCalled();
  });
});
