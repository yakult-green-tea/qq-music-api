// 旧歌单 CGI 在中国大陆出口对部分公开歌单回 code 0 / subcode 4000（check privacy error!），没有歌单内容。
// 这时改用匿名 musicu 的 uniform_get_Dissinfo 读同一张公开歌单，改写成旧 CGI 的形状；其余情况都和原来一样。
const mockYCommon = jest.fn();

jest.mock('../src/services/y_common', () => ({
  __esModule: true,
  default: mockYCommon,
}));

jest.mock('../src/util/logger', () => ({
  __esModule: true,
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import type { HttpTransport } from '../src/protocol/http';
import { toSongListDetailResponse } from '../src/services/songLists/officialPlaylist';
import { readPublicSongListDetail } from '../src/services/songLists/publicPlaylist';
import songListDetail from '../src/services/songLists/songListDetail';
import { logger } from '../src/util/logger';

const mockedLogger = logger as jest.Mocked<typeof logger>;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const privacyRejected = { code: 0, subcode: 4000, msg: 'check privacy error!' };
const fcgCode10 = () => clone(require('./fixtures/official-playlists/fcg-code-10.json'));

const publicData = (overrides: Record<string, unknown> = {}) => ({
  code: 0,
  subcode: 0,
  dirinfo: {
    id: 8322594955,
    title: '公开歌单',
    picurl: 'https://y.gtimg.cn/music/photo_new/T002R300x300M000fixtureCover.jpg',
    desc: '歌单简介',
    host_nick: '歌单作者',
    host_uin: 10001,
    dir_show: 1,
    dirid: 3,
    songnum: 2,
    listennum: 1234,
  },
  songlist: [
    { mid: 'songA', album: { mid: 'albumA' } },
    { mid: 'songB', album: { mid: 'albumB' } },
  ],
  total_song_num: 2,
  hasmore: 0,
  ...overrides,
});

describe('toSongListDetailResponse 的公开歌单写法', () => {
  it('封面优先用歌单自己的 picurl，不用第一首的专辑图', () => {
    const detail = toSongListDetailResponse(publicData(), { publicPlaylist: true })?.cdlist[0];
    expect(detail?.logo).toBe(publicData().dirinfo.picurl);
  });

  it('官方歌单的写法不变：仍用第一首的专辑图', () => {
    const detail = toSongListDetailResponse(publicData())?.cdlist[0];
    expect(detail?.logo).toBe(
      'https://y.gtimg.cn/music/photo_new/T002R300x300M000albumA.jpg?max_age=2592000',
    );
  });

  it('没有 picurl 时退回第一首的专辑图', () => {
    const data = publicData();
    data.dirinfo.picurl = '';
    expect(toSongListDetailResponse(data, { publicPlaylist: true })?.cdlist[0].logo).toBe(
      'https://y.gtimg.cn/music/photo_new/T002R300x300M000albumA.jpg?max_age=2592000',
    );
  });

  it('公开的空歌单正常返回，官方写法仍判成读不到', () => {
    const empty = publicData({ songlist: [], total_song_num: 0 });
    expect(toSongListDetailResponse(empty, { publicPlaylist: true })?.cdlist[0]).toMatchObject({
      disstid: '8322594955',
      dissname: '公开歌单',
      songlist: [],
      songnum: 0,
      total_song_num: 0,
    });
    expect(toSongListDetailResponse(empty)).toBeNull();
  });

  it('不公开（dir_show 不是 1）的空歌单仍判成读不到', () => {
    const data = publicData({ songlist: [] });
    data.dirinfo.dir_show = 0;
    expect(toSongListDetailResponse(data, { publicPlaylist: true })).toBeNull();
  });

  it('播放数只沿用 listennum，不补 visitnum', () => {
    const detail = toSongListDetailResponse(publicData(), { publicPlaylist: true })?.cdlist[0];
    expect(detail).toMatchObject({ listennum: 1234 });
    expect(detail).not.toHaveProperty('visitnum');
  });
});

describe('readPublicSongListDetail', () => {
  const reply = (data: unknown, code = 0) => ({
    status: 200,
    body: { code: 0, req_0: { code, data } },
  });
  const transportOf = (...pages: unknown[]) => {
    const requests: Array<{
      url: string;
      body: Record<string, any>;
      headers: Record<string, string>;
    }> = [];
    const http: HttpTransport = async (request) => {
      requests.push({
        url: request.url,
        body: JSON.parse(String(request.body)),
        headers: request.headers ?? {},
      });
      const next = pages.shift();
      if (next instanceof Error) throw next;
      return next as never;
    };
    return { http, requests };
  };

  it('匿名请求：网页身份、不带 Cookie、歌单 id 用数字', async () => {
    const { http, requests } = transportOf(reply(publicData()));

    const result = await readPublicSongListDetail('8322594955', { http });

    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe('https://u.y.qq.com/cgi-bin/musicu.fcg');
    expect(requests[0].body.comm).toEqual({ ct: 24, cv: 0 });
    expect(requests[0].body.req_0).toEqual({
      module: 'music.srfDissInfo.aiDissInfo',
      method: 'uniform_get_Dissinfo',
      param: {
        disstid: 8322594955,
        userinfo: 1,
        tag: 1,
        orderlist: 1,
        song_begin: 0,
        song_num: 1000,
        onlysonglist: 0,
        enc_host_uin: '',
      },
    });
    expect(JSON.stringify(requests[0].headers).toLowerCase()).not.toContain('cookie');
    expect(result?.cdlist[0]).toMatchObject({
      disstid: '8322594955',
      dissname: '公开歌单',
      songlist: publicData().songlist,
      hasmore: 0,
    });
  });

  it('按 hasmore 续页，从已读的歌数接着读', async () => {
    const first = publicData({
      songlist: [{ mid: 'songA' }],
      total_song_num: 2,
      hasmore: 1,
    });
    const second = publicData({ songlist: [{ mid: 'songB' }], total_song_num: 2, hasmore: 0 });
    const { http, requests } = transportOf(reply(first), reply(second));

    const result = await readPublicSongListDetail('8322594955', { http });

    expect(requests.map((r) => r.body.req_0.param.song_begin)).toEqual([0, 1]);
    expect(result?.cdlist[0].songlist).toEqual([{ mid: 'songA' }, { mid: 'songB' }]);
    expect(result?.cdlist[0].hasmore).toBe(0);
  });

  it.each([
    ['abc'],
    ['0'],
    ['-1'],
    ['1.5'],
    ['99999999999999999999'],
    [''],
  ])('歌单 id %p 不是正整数：不发请求，返回 null', async (id) => {
    const { http, requests } = transportOf();
    await expect(readPublicSongListDetail(id, { http })).resolves.toBeNull();
    expect(requests).toHaveLength(0);
  });

  it('读回的歌单 id 对不上：返回 null', async () => {
    const data = publicData();
    data.dirinfo.id = 1;
    const { http } = transportOf(reply(data));
    await expect(readPublicSongListDetail('8322594955', { http })).resolves.toBeNull();
  });

  it('歌单不公开（dir_show 不是 1）：返回 null', async () => {
    const data = publicData();
    data.dirinfo.dir_show = 0;
    const { http } = transportOf(reply(data));
    await expect(readPublicSongListDetail('8322594955', { http })).resolves.toBeNull();
  });

  it.each([
    ['里层 code 非零', publicData({ code: 1 })],
    ['里层 subcode 非零', publicData({ subcode: 4000 })],
  ])('%s：返回 null', async (_label, data) => {
    const { http } = transportOf(reply(data));
    await expect(readPublicSongListDetail('8322594955', { http })).resolves.toBeNull();
  });

  it('单项业务码非零：抛错，交给调用方保留原回应', async () => {
    const { http } = transportOf(reply({}, 80120));
    await expect(readPublicSongListDetail('8322594955', { http })).rejects.toThrow();
  });
});

describe('services/songListDetail：subcode 4000 时改读公开歌单', () => {
  const adapted = () => toSongListDetailResponse(publicData(), { publicPlaylist: true });

  beforeEach(() => {
    mockYCommon.mockReset();
    jest.clearAllMocks();
  });

  it('没登录也改读，回改写后的结果并记下来源', async () => {
    mockYCommon.mockResolvedValue({ data: clone(privacyRejected) });
    const readPublicPlaylist = jest.fn().mockResolvedValue(adapted());

    const result = await songListDetail({ params: { disstid: '8322594955' }, readPublicPlaylist });

    expect(readPublicPlaylist).toHaveBeenCalledWith('8322594955');
    expect(result).toEqual({ status: 200, body: { response: adapted() } });
    expect(mockedLogger.info).toHaveBeenCalledWith(
      'service.succeeded',
      expect.objectContaining({
        service: 'songListDetail',
        disstid: '8322594955',
        source: 'public-fallback',
      }),
    );
  });

  it('匿名读不到、请求带着会话：再用凭据读', async () => {
    mockYCommon.mockResolvedValue({ data: clone(privacyRejected) });
    const readPublicPlaylist = jest.fn().mockResolvedValue(null);
    const readWithCredential = jest.fn().mockResolvedValue(publicData());

    const result = await songListDetail({
      params: { disstid: '8322594955' },
      readPublicPlaylist,
      readWithCredential,
    });

    expect(readPublicPlaylist).toHaveBeenCalledTimes(1);
    expect(readWithCredential).toHaveBeenCalledWith('8322594955');
    expect(result.body).toEqual({
      response: toSongListDetailResponse(publicData(), { publicPlaylist: true }),
    });
  });

  it('匿名读成功就不再用凭据读', async () => {
    mockYCommon.mockResolvedValue({ data: clone(privacyRejected) });
    const readWithCredential = jest.fn();

    await songListDetail({
      params: { disstid: '8322594955' },
      readPublicPlaylist: jest.fn().mockResolvedValue(adapted()),
      readWithCredential,
    });

    expect(readWithCredential).not.toHaveBeenCalled();
  });

  it('两条都读不到：原样返回 4000', async () => {
    mockYCommon.mockResolvedValue({ data: clone(privacyRejected) });

    const result = await songListDetail({
      params: { disstid: '8322594955' },
      readPublicPlaylist: jest.fn().mockResolvedValue(null),
      readWithCredential: jest.fn().mockResolvedValue(null),
    });

    expect(result).toEqual({ status: 200, body: { response: privacyRejected } });
  });

  it('匿名读抛错：原样返回 4000，日志只带错误类型与上游码', async () => {
    mockYCommon.mockResolvedValue({ data: clone(privacyRejected) });

    const result = await songListDetail({
      params: { disstid: '8322594955' },
      readPublicPlaylist: jest
        .fn()
        .mockRejectedValue(
          Object.assign(new Error('fixture-private'), { name: 'QqApiError', upstreamCode: 80120 }),
        ),
    });

    expect(result).toEqual({ status: 200, body: { response: privacyRejected } });
    expect(mockedLogger.warn).toHaveBeenCalledWith('service.public_fallback_failed', {
      service: 'songListDetail',
      disstid: '8322594955',
      name: 'QqApiError',
      upstreamCode: 80120,
    });
    expect(JSON.stringify(mockedLogger.warn.mock.calls)).not.toContain('fixture-private');
  });

  it.each([
    [
      '4000 但带着能读的歌单',
      { ...privacyRejected, cdlist: [{ dissname: '有内容', songlist: [] }] },
    ],
    ['code 非零的 4000', { code: 1, subcode: 4000 }],
    ['subcode 0', { code: 0, subcode: 0, cdlist: [{ dissname: '公开歌单', songlist: [] }] }],
    ['不公开歌单的空壳', { code: 0, cdlist: [{ disstid: '9777066643', songlist: [] }] }],
  ])('%s：不改读', async (_label, upstream) => {
    mockYCommon.mockResolvedValue({ data: clone(upstream) });
    const readPublicPlaylist = jest.fn();

    const result = await songListDetail({ params: { disstid: '8322594955' }, readPublicPlaylist });

    expect(result).toEqual({ status: 200, body: { response: upstream } });
    expect(readPublicPlaylist).not.toHaveBeenCalled();
  });

  it('code 10 仍只走凭据重读，不改读公开歌单', async () => {
    mockYCommon.mockResolvedValue({ data: fcgCode10() });
    const readPublicPlaylist = jest.fn();

    const result = await songListDetail({ params: { disstid: '211192' }, readPublicPlaylist });

    expect(readPublicPlaylist).not.toHaveBeenCalled();
    expect(result).toEqual({ status: 200, body: { response: fcgCode10() } });
  });

  it('4000 但没有 disstid：不改读', async () => {
    mockYCommon.mockResolvedValue({ data: clone(privacyRejected) });
    const readPublicPlaylist = jest.fn();

    await songListDetail({ params: {}, readPublicPlaylist });

    expect(readPublicPlaylist).not.toHaveBeenCalled();
  });
});
