import type { AxiosRequestConfig, AxiosResponse } from 'axios';
import { createAndroidDevice } from '../src/services/auth/androidDevice';
import type { AuthHttpClient } from '../src/services/auth/httpClient';
import {
  type AuthSession,
  createQrLoginService,
  QqProtocolError,
  type SessionResolver,
} from '../src/services/auth/qrLogin';
import { AuthCredentialRejectedError } from '../src/util/authError';
import { logger } from '../src/util/logger';
import aiDissInfo211111 from './fixtures/official-playlists/ai-dissinfo-211111.json';
import aiDissInfo211192 from './fixtures/official-playlists/ai-dissinfo-211192.json';
import aiDissInfoDailyLimit1 from './fixtures/official-playlists/ai-dissinfo-daily-limit-1.json';
import createdPlaylists from './fixtures/official-playlists/user-playlist-created.json';
import favoritePlaylists from './fixtures/official-playlists/user-playlist-favorites.json';

// 官方歌单的两件事：带凭据读匿名 CGI 读不到的算法歌单（getAuthenticatedSongListDetail），
// 以及 /user/playlist 里歌单的封面。上游回应按实测结构整理，名称与 id 都是假数据。

const TOKEN = 'fixture-session-token';
const MUSICKEY = 'fixture-musickey';
const DAILY_TID = 9000000030;

const coverOf = (albumMid: string) =>
  `https://y.gtimg.cn/music/photo_new/T002R300x300M000${albumMid}.jpg?max_age=2592000`;
const COVER_DAILY = coverOf('000FixAlbum007');
const COVER_211192 = coverOf('000FixAlbum001');
const COVER_211111 = coverOf('000FixAlbum004');

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const response = <T>(data: T): AxiosResponse<T> => ({
  data,
  status: 200,
  statusText: 'OK',
  headers: {} as AxiosResponse<T>['headers'],
  config: { headers: {} } as AxiosResponse<T>['config'],
});

const envelope = (data: unknown, code = 0) => ({ code: 0, req_0: { code, data } });

type DissReply = unknown | Error | Promise<unknown>;

interface HarnessOptions {
  /** 按 disstid 给出 uniform_get_Dissinfo 的回应；返回 Error 表示上游拒绝时的 req_0.code。 */
  diss?: (param: Record<string, any>) => DissReply;
  favorites?: unknown[];
  created?: Record<string, unknown>[];
}

interface MusicuCall {
  method: string;
  module: string;
  param: Record<string, any>;
  cookie: string;
}

const defaultDiss = (param: Record<string, any>): DissReply => {
  if (param.disstid === 211192) return clone(aiDissInfo211192);
  if (param.disstid === 211111) return clone(aiDissInfo211111);
  if (param.disstid === DAILY_TID) return clone(aiDissInfoDailyLimit1);
  return envelope({}, 10004);
};

const createHarness = (options: HarnessOptions = {}) => {
  const calls: MusicuCall[] = [];
  const post = jest.fn(async <T>(_url: string, payload?: unknown, config?: AxiosRequestConfig) => {
    const request = (payload as { req_0: { module: string; method: string; param: any } }).req_0;
    calls.push({
      method: request.method,
      module: request.module,
      param: request.param,
      cookie: String((config?.headers as Record<string, unknown> | undefined)?.Cookie ?? ''),
    });
    if (request.method === 'GetPlaylistByUin')
      return response(
        envelope({
          ...clone(createdPlaylists),
          v_playlist: options.created ?? clone(createdPlaylists.v_playlist),
        }),
      ) as AxiosResponse<T>;
    if (request.method === 'CgiGetPlaylistFavInfo')
      return response(
        envelope({
          ...clone(favoritePlaylists),
          v_list: options.favorites ?? clone(favoritePlaylists.v_list),
        }),
      ) as AxiosResponse<T>;
    if (request.method === 'uniform_get_Dissinfo') {
      const reply = await (options.diss ?? defaultDiss)(request.param);
      if (reply instanceof Error) throw reply;
      return response(reply) as AxiosResponse<T>;
    }
    throw new Error(`Unexpected method: ${request.method}`);
  });
  const http = {
    getCookieHeader: () => '',
    request: jest.fn(),
    post,
  } as unknown as AuthHttpClient;
  const session: AuthSession = {
    token: TOKEN,
    credential: {
      musicid: '42',
      musickey: MUSICKEY,
      loginType: 1,
      encryptUin: 'fixture-encrypt-uin',
    },
    device: createAndroidDevice(),
    expiresAt: Date.now() + 3_600_000,
  };
  const sessionResolver: SessionResolver = {
    mode: 'stored',
    issue: async () => TOKEN,
    resolve: async (token) => (token === TOKEN ? session : null),
    revoke: async () => undefined,
  };
  const service = createQrLoginService({ http, sessionResolver });
  const dissCalls = () => calls.filter((call) => call.method === 'uniform_get_Dissinfo');
  return { service, calls, dissCalls };
};

/** 让出事件循环直到条件成立；上限之内不成立就让测试失败，而不是挂住。 */
const waitFor = async (condition: () => boolean) => {
  for (let i = 0; i < 100 && !condition(); i += 1) await new Promise(setImmediate);
  expect(condition()).toBe(true);
};

/**
 * 一页 `size` 首、实际共 `actual` 首的分页上游。`hasmore` 与上报的 `total_song_num` 都可以另给，
 * 用来模拟上游自相矛盾的情况。
 */
const pagedDiss =
  (
    actual: number,
    size: number,
    options: { hasmore?: (begin: number) => number; reportedTotal?: number } = {},
  ) =>
  (param: Record<string, any>) => {
    const count = Math.max(0, Math.min(size, actual - param.song_begin));
    const songs = Array.from({ length: count }, (_, i) => ({
      mid: `song-${param.song_begin + i}`,
      album: { mid: 'albumMid0001' },
    }));
    return envelope({
      dirinfo: { id: param.disstid, title: '分页歌单' },
      songlist: songs,
      total_song_num: options.reportedTotal ?? actual,
      hasmore: options.hasmore
        ? options.hasmore(param.song_begin)
        : +(param.song_begin + size < actual),
    });
  };

afterEach(() => {
  jest.restoreAllMocks();
});

describe('getAuthenticatedSongListDetail', () => {
  it('没有会话时返回 null，且不打上游', async () => {
    const { service, calls } = createHarness();

    await expect(service.getAuthenticatedSongListDetail(undefined, 211192)).resolves.toBeNull();
    await expect(
      service.getAuthenticatedSongListDetail('unknown-token', 211192),
    ).resolves.toBeNull();
    expect(calls).toEqual([]);
  });

  it('disstid 不是正整数时返回 null，且不打上游', async () => {
    const { service, calls } = createHarness();

    for (const disstid of [undefined, '', 'abc', '0', 0, '-5', -5, '1.5', 1.5, '211192abc', ' ']) {
      await expect(service.getAuthenticatedSongListDetail(TOKEN, disstid)).resolves.toBeNull();
    }
    expect(calls).toEqual([]);
  });

  it('带凭据走 uniform_get_Dissinfo 读整张歌单', async () => {
    const { service, dissCalls } = createHarness();

    const data = await service.getAuthenticatedSongListDetail(TOKEN, '211192');

    expect(data).toMatchObject({
      dirinfo: { id: 211192, title: '歌手漫游 | 专享歌手Mix' },
      total_song_num: 50,
    });
    expect((data?.songlist as unknown[]).length).toBe(3);
    expect(dissCalls()).toEqual([
      {
        module: 'music.srfDissInfo.aiDissInfo',
        method: 'uniform_get_Dissinfo',
        param: {
          disstid: 211192,
          userinfo: 1,
          tag: 1,
          orderlist: 1,
          song_begin: 0,
          song_num: 1000,
          onlysonglist: 0,
          enc_host_uin: '',
        },
        cookie: expect.stringContaining(`qm_keyst=${MUSICKEY}`),
      },
    ]);
  });

  it('给了 limit 就只读一页，即使上游说还有更多', async () => {
    const { service, dissCalls } = createHarness();

    const data = await service.getAuthenticatedSongListDetail(TOKEN, DAILY_TID, { limit: 1 });

    expect(data?.hasmore).toBe(1);
    expect((data?.songlist as unknown[]).length).toBe(1);
    expect(dissCalls().map((call) => [call.param.song_begin, call.param.song_num])).toEqual([
      [0, 1],
    ]);
  });

  it('limit 被夹在 1 到 1000 之间', async () => {
    const { service, dissCalls } = createHarness();

    await service.getAuthenticatedSongListDetail(TOKEN, 211192, { limit: 0 });
    await service.getAuthenticatedSongListDetail(TOKEN, 211192, { limit: 5000 });
    await service.getAuthenticatedSongListDetail(TOKEN, 211192, { limit: 2.9 });

    expect(dissCalls().map((call) => call.param.song_num)).toEqual([1, 1000, 2]);
  });

  it('limit 不是有限数字时当作没给，按整张歌单读', async () => {
    const { service, dissCalls } = createHarness({ diss: pagedDiss(3, 2) });

    const data = await service.getAuthenticatedSongListDetail(TOKEN, 7, { limit: Number.NaN });

    expect((data?.songlist as unknown[]).length).toBe(3);
    expect(dissCalls().map((call) => call.param.song_num)).toEqual([1000, 1000]);
  });

  it('上游没给 total_song_num 时只看 hasmore 与空页', async () => {
    const diss = pagedDiss(3, 2);
    const { service, dissCalls } = createHarness({
      diss: (param) => {
        const page = diss(param) as { req_0: { data: Record<string, unknown> } };
        delete page.req_0.data.total_song_num;
        page.req_0.data.hasmore = true;
        return page;
      },
    });

    const data = await service.getAuthenticatedSongListDetail(TOKEN, 7);

    expect((data?.songlist as unknown[]).length).toBe(3);
    expect(dissCalls().map((call) => call.param.song_begin)).toEqual([0, 2, 3]);
  });

  it('按 hasmore 续读，把各页的歌接起来', async () => {
    const { service, dissCalls } = createHarness({ diss: pagedDiss(5, 2) });

    const data = await service.getAuthenticatedSongListDetail(TOKEN, 7);

    expect((data?.songlist as { mid: string }[]).map((song) => song.mid)).toEqual([
      'song-0',
      'song-1',
      'song-2',
      'song-3',
      'song-4',
    ]);
    expect(data).toMatchObject({ dirinfo: { title: '分页歌单' }, total_song_num: 5, hasmore: 0 });
    expect(dissCalls().map((call) => call.param.song_begin)).toEqual([0, 2, 4]);
  });

  it('上游说还有、但这一页是空的，就停', async () => {
    // 实际只有 4 首，上游却报 100 首并一直说还有
    const { service, dissCalls } = createHarness({
      diss: pagedDiss(4, 2, { hasmore: () => 1, reportedTotal: 100 }),
    });

    const data = await service.getAuthenticatedSongListDetail(TOKEN, 7);

    expect((data?.songlist as unknown[]).length).toBe(4);
    // 第三页（begin 4）是空页
    expect(dissCalls().map((call) => call.param.song_begin)).toEqual([0, 2, 4]);
  });

  it('已经读满 total 就停，不再相信 hasmore', async () => {
    const { service, dissCalls } = createHarness({
      diss: pagedDiss(4, 2, { hasmore: () => 1 }),
    });

    const data = await service.getAuthenticatedSongListDetail(TOKEN, 7);

    expect((data?.songlist as unknown[]).length).toBe(4);
    expect(dissCalls().map((call) => call.param.song_begin)).toEqual([0, 2]);
  });

  it('上游一直说还有更多时，最多读 10 页', async () => {
    const { service, dissCalls } = createHarness({
      diss: pagedDiss(1_000_000, 1, { hasmore: () => 1 }),
    });

    const data = await service.getAuthenticatedSongListDetail(TOKEN, 7);

    expect(dissCalls().length).toBe(10);
    expect((data?.songlist as unknown[]).length).toBe(10);
  });

  it('歌单不存在时把上游码原样抛出', async () => {
    const { service } = createHarness();

    const failure = service.getAuthenticatedSongListDetail(TOKEN, 9999999999999);

    await expect(failure).rejects.toBeInstanceOf(QqProtocolError);
    await expect(failure).rejects.toMatchObject({ upstreamCode: 10004 });
  });

  it('上游拒绝凭据时抛 AuthCredentialRejectedError，与其他带凭据的读取一致', async () => {
    const { service } = createHarness({ diss: () => envelope({}, 1000) });

    await expect(service.getAuthenticatedSongListDetail(TOKEN, 211192)).rejects.toBeInstanceOf(
      AuthCredentialRejectedError,
    );
  });

  it('上游回应没有 songlist 时当成没有歌，不续页', async () => {
    const { service, dissCalls } = createHarness({
      diss: () => envelope({ dirinfo: { id: 7, title: '没有歌' }, total_song_num: 0, hasmore: 1 }),
    });

    const data = await service.getAuthenticatedSongListDetail(TOKEN, 7);

    expect(data?.songlist).toEqual([]);
    expect(dissCalls().length).toBe(1);
  });

  it('回应里的私密字段被滤掉', async () => {
    const { service } = createHarness({
      diss: () => {
        const reply = clone(aiDissInfo211192) as Record<string, any>;
        reply.req_0.data.musickey = 'must-not-leak';
        reply.req_0.data.dirinfo.qqmusic_key = 'must-not-leak';
        return reply;
      },
    });

    const data = await service.getAuthenticatedSongListDetail(TOKEN, 211192);

    expect(JSON.stringify(data)).not.toContain('must-not-leak');
  });
});

/** 普通收藏补上原本的封面（logo）之后的样子；官方歌单与自建歌单都不在这一步动。 */
const withOriginalCovers = (entries: Record<string, any>[]) =>
  entries.map((entry) =>
    entry.dirType === 0 ? { ...entry, bigpicUrl: entry.logo, picUrl: entry.logo } : entry,
  );

/** 官方歌单还没补封面时的 /user/playlist：自建原样、普通收藏沿用原本的封面。 */
const mergedBeforeOfficialCovers = () => [
  ...clone(createdPlaylists.v_playlist),
  ...withOriginalCovers(clone(favoritePlaylists.v_list)),
];

describe('getUserPlaylists：官方歌单的封面', () => {
  it('官方歌单换成第一首歌的专辑封面，普通收藏沿用原本的封面，自建歌单原样', async () => {
    const { service, dissCalls } = createHarness();

    const result = await service.getUserPlaylists(TOKEN);

    const expected = mergedBeforeOfficialCovers();
    expect(expected[5]).toMatchObject({ picUrl: 'https://y.qq.com/fixture/custom-cover-1.jpg' });
    Object.assign(expected[2], { bigpicUrl: COVER_DAILY, picUrl: COVER_DAILY });
    Object.assign(expected[3], { bigpicUrl: COVER_211192, picUrl: COVER_211192 });
    Object.assign(expected[4], { bigpicUrl: COVER_211111, picUrl: COVER_211111 });
    expect(result).toEqual({ v_playlist: expected, total: 7, bFinish: true });
    // logo / albumPicUrl 保留上游原值，不被改写
    expect(result?.v_playlist).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tid: DAILY_TID,
          logo: 'http://y.qq.com/m/resource/calendar/1009_300.jpg',
        }),
      ]),
    );
    expect(
      dissCalls()
        .map((call) => [call.param.disstid, call.param.song_begin, call.param.song_num])
        .sort(),
    ).toEqual(
      [
        [211111, 0, 1],
        [211192, 0, 1],
        [DAILY_TID, 0, 1],
      ].sort(),
    );
    for (const call of dissCalls()) expect(call.cookie).toContain(`qm_keyst=${MUSICKEY}`);
  });

  it('官方歌单原本带着封面字段也一律换掉', async () => {
    const favorites = clone(favoritePlaylists.v_list).map((entry) =>
      entry.tid === 211111 ? { ...entry, picUrl: 'stale-pic', bigpicUrl: 'stale-big' } : entry,
    );
    const { service } = createHarness({ favorites });

    const result = await service.getUserPlaylists(TOKEN);

    expect((result?.v_playlist as Record<string, unknown>[])[4]).toMatchObject({
      tid: 211111,
      picUrl: COVER_211111,
      bigpicUrl: COVER_211111,
    });
  });

  it('读不到第一首的专辑时条目原样（不拿 logo 顶替），/user/playlist 照常返回', async () => {
    const warn = jest.spyOn(logger, 'warn');
    const { service } = createHarness({
      diss: (param) => {
        if (param.disstid === 211192) return envelope({}, 10004);
        if (param.disstid === 211111) return envelope({}, 1000);
        const daily = clone(aiDissInfoDailyLimit1) as Record<string, any>;
        daily.req_0.data.songlist[0].album = { mid: '' };
        return daily;
      },
    });

    const result = await service.getUserPlaylists(TOKEN);

    expect(result).toEqual({ v_playlist: mergedBeforeOfficialCovers(), total: 7, bFinish: true });
    // 官方歌单的规则是第一首歌的专辑图，读不到就不给封面，不退回歌单自己的 logo
    for (const entry of (result?.v_playlist as Record<string, unknown>[]).slice(2, 5)) {
      expect(entry).not.toHaveProperty('picUrl');
      expect(entry).not.toHaveProperty('bigpicUrl');
    }
    expect(warn).toHaveBeenCalledWith(
      'qq-auth.official-playlist-cover-failed',
      expect.objectContaining({ name: 'QqProtocolError', upstreamCode: 10004 }),
    );
    expect(warn).toHaveBeenCalledWith(
      'qq-auth.official-playlist-cover-failed',
      expect.objectContaining({ name: 'AuthCredentialRejectedError' }),
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain(MUSICKEY);
  });

  it('网络错误也只让这一条没有封面', async () => {
    const { service } = createHarness({
      diss: (param) =>
        param.disstid === 211192 ? new Error('socket hang up') : defaultDiss(param),
    });

    const result = (await service.getUserPlaylists(TOKEN))?.v_playlist as Record<string, unknown>[];

    expect(result[3]).not.toHaveProperty('picUrl');
    expect(result[4]).toMatchObject({ picUrl: COVER_211111 });
  });

  it('上游抛出的不是 Error 也照样只跳过这一条', async () => {
    const warn = jest.spyOn(logger, 'warn');
    const { service } = createHarness({
      diss: (param) => (param.disstid === 211192 ? Promise.reject('boom') : defaultDiss(param)),
    });

    const result = (await service.getUserPlaylists(TOKEN))?.v_playlist as Record<string, unknown>[];

    expect(result[3]).not.toHaveProperty('picUrl');
    expect(warn).toHaveBeenCalledWith('qq-auth.official-playlist-cover-failed', {
      name: 'Error',
      upstreamCode: undefined,
    });
  });

  it('没有可用 tid 的官方条目不打上游、原样保留', async () => {
    const favorites = [
      { name: '没有 tid', dirType: 3 },
      { tid: 'abc', name: 'tid 不是数字', dirType: 3 },
    ];
    const { service, dissCalls } = createHarness({ favorites });

    const result = await service.getUserPlaylists(TOKEN);

    expect((result?.v_playlist as unknown[]).slice(2)).toEqual(favorites);
    expect(dissCalls()).toEqual([]);
  });

  it('没有官方歌单时不多打任何请求', async () => {
    const favorites = clone(favoritePlaylists.v_list).filter((entry) => entry.dirType === 0);
    const { service, dissCalls } = createHarness({ favorites });

    const result = await service.getUserPlaylists(TOKEN);

    expect(result?.v_playlist).toEqual([
      ...clone(createdPlaylists.v_playlist),
      ...withOriginalCovers(favorites),
    ]);
    expect(dissCalls()).toEqual([]);
  });

  it('一次最多补 20 张，超出的原样', async () => {
    const favorites = Array.from({ length: 25 }, (_, i) => ({
      tid: 211000 + i,
      dirId: 211000 + i,
      dirType: 3,
      name: `算法歌单 ${i}`,
    }));
    const { service, dissCalls } = createHarness({ favorites, diss: pagedDiss(50, 50) });

    const result = (await service.getUserPlaylists(TOKEN))?.v_playlist as Record<string, unknown>[];

    expect(dissCalls().length).toBe(20);
    const covered = result.filter((entry) => entry.picUrl === coverOf('albumMid0001'));
    expect(covered.map((entry) => entry.tid)).toEqual(favorites.slice(0, 20).map((e) => e.tid));
    expect(result.slice(2 + 20)).toEqual(favorites.slice(20));
  });

  it('各条目的读取同时发出，不是一条等一条', async () => {
    const pending: Array<() => void> = [];
    const { service, dissCalls } = createHarness({
      diss: (param) =>
        new Promise((resolve) => {
          pending.push(() => resolve(defaultDiss(param)));
        }),
    });

    const result = service.getUserPlaylists(TOKEN);
    await waitFor(() => dissCalls().length === 3);
    for (const release of pending) release();

    await expect(result).resolves.toMatchObject({ total: 7 });
  });
});

// 收藏的他人歌单：收藏者改不了封面，歌单主人设成什么（自定义图、第一首歌的专辑……）就显示什么。
// 上游只给 logo / albumPicUrl，下游读的是 bigpicUrl / picUrl，所以照自建歌单条目的字段名补上。
describe('getUserPlaylists：收藏的他人歌单沿用原本的封面', () => {
  const normalFavorite = (overrides: Record<string, unknown>) => ({
    tid: 9100000001,
    dirId: 11,
    dirType: 0,
    name: '普通收藏',
    songnum: 225,
    logo: 'https://y.qq.com/fixture/custom-cover-1.jpg',
    albumPicUrl: '',
    ...overrides,
  });
  const favoritesOf = async (favorites: unknown[]) => {
    const { service, dissCalls } = createHarness({ favorites });
    const result = await service.getUserPlaylists(TOKEN);
    expect(dissCalls()).toEqual([]);
    return (result?.v_playlist as unknown[]).slice(2);
  };

  it('用 logo 作封面，不多打任何请求', async () => {
    const [entry] = await favoritesOf([normalFavorite({})]);

    expect(entry).toEqual({
      ...normalFavorite({}),
      bigpicUrl: 'https://y.qq.com/fixture/custom-cover-1.jpg',
      picUrl: 'https://y.qq.com/fixture/custom-cover-1.jpg',
    });
  });

  it('logo 为空时退回 albumPicUrl', async () => {
    const albumPicUrl = 'http://y.gtimg.cn/music/photo_new/T002R300x300M000000FixAlbum007.jpg';

    const [entry] = await favoritesOf([normalFavorite({ logo: '  ', albumPicUrl })]);

    expect(entry).toMatchObject({ bigpicUrl: albumPicUrl, picUrl: albumPicUrl });
  });

  it('两个都没有时原样，不编一个封面出来', async () => {
    const favorites = [
      normalFavorite({ logo: '', albumPicUrl: '' }),
      normalFavorite({ tid: 2, logo: undefined, albumPicUrl: undefined }),
      normalFavorite({ tid: 3, logo: 12345 }),
    ];

    expect(await favoritesOf(clone(favorites))).toEqual(favorites);
  });

  it('已经带着封面字段的条目不覆盖；字段是空字符串才补', async () => {
    const favorites = [
      normalFavorite({ picUrl: 'https://y.qq.com/fixture/existing.jpg' }),
      normalFavorite({ tid: 2, bigpicUrl: 'https://y.qq.com/fixture/existing-big.jpg' }),
      normalFavorite({ tid: 3, coverUrl: 'https://y.qq.com/fixture/existing-cover.jpg' }),
      normalFavorite({ tid: 4, picurl: 'https://y.qq.com/fixture/existing-lower.jpg' }),
      normalFavorite({ tid: 5, picUrl: '' }),
    ];

    const result = (await favoritesOf(clone(favorites))) as Record<string, unknown>[];

    expect(result.slice(0, 4)).toEqual(favorites.slice(0, 4));
    expect(result[4]).toMatchObject({
      picUrl: 'https://y.qq.com/fixture/custom-cover-1.jpg',
      bigpicUrl: 'https://y.qq.com/fixture/custom-cover-1.jpg',
    });
  });

  it('只动收藏列表：自建歌单就算带着 logo 也原样', async () => {
    const created = [
      { tid: 9000000035, dirId: 35, dirName: '自建', logo: 'https://y.qq.com/x.jpg' },
    ];
    const { service } = createHarness({ created, favorites: [] });

    const result = await service.getUserPlaylists(TOKEN);

    expect(result?.v_playlist).toEqual(created);
  });

  it('不是对象的收藏条目原样', async () => {
    expect(await favoritesOf([null, 'not-an-entry'])).toEqual([null, 'not-an-entry']);
  });
});
