import './helpers/sessionRoutes';
import { CATALOG_RUNTIMES, callRoute } from './helpers/catalogRoutes';
import { useSessionUpstream } from './helpers/sessionRoutes';

// 首页 feed 只读第 1 页（续页组合实测回 500020）。歌曲卡只有数字 songid，用 CgiGetTrackInfo 补全；
// 歌单只收 500/3003/513；节目、电台、运营入口、动态日推卡都不收。编号、名字都是虚构示例。

const card = (
  type: number,
  jumptype: number,
  subtype: number,
  id: string,
  extra: Record<string, unknown> = {},
) => ({
  type,
  jumptype,
  subtype,
  id,
  title: `card-${id}`,
  subtitle: `sub-${id}`,
  cover: `https://y.gtimg.cn/fixture-${id}.jpg`,
  ...extra,
});
const niche = (...cards: unknown[]) => ({ v_card: cards });
const SHELVES = [
  {
    id: 9001,
    title_template: 'Hi {String}  今日为你推荐',
    title_content: 'fixture-nick',
    v_niche: [
      niche(
        card(700, 20001, 711, '99'),
        card(500, 10014, 510, '8000000001'),
        card(500, 3003, 513, '700001'),
        card(900, 3003, 991, '1'),
        card(500, 3003, 513, '700002'),
      ),
    ],
  },
  {
    id: 9002,
    title_template: '心动的歌曲推荐',
    title_content: 'fixture-seed',
    v_niche: [
      niche(card(200, 10046, 0, '101'), card(200, 10046, 201, '102')),
      niche(card(200, 10046, 0, '103'), card(200, 10046, 0, '101')),
    ],
  },
  {
    id: 9003,
    title_template: '',
    title_content: '',
    v_niche: [niche(card(1700, 20007, 0, '5001'), card(400, 10025, 410, '6001'))],
  },
];
type FeedBody = { shelves: Array<{ id: string; items: unknown[] }> };
const feedOf = (result: { body: unknown }) => result.body as FeedBody;
const track = (id: number) => ({
  id,
  mid: `fixtureMid${id}`,
  name: `song ${id}`,
  singer: [{ mid: 's', name: 'singer' }],
  album: { mid: 'a', name: 'album' },
});

describe.each(CATALOG_RUNTIMES)('/recommend/feed（%s）', (runtime) => {
  const upstream = useSessionUpstream(runtime);
  const call = async (mode: 'valid' | 'missing' = 'valid') => {
    const options = await upstream.options(mode);
    await options.beforeEachLeg?.();
    return callRoute(runtime, '/recommend/feed', {
      headers: options.token ? { 'X-QQ-Session': options.token } : {},
      env: options.env,
    });
  };
  const rpcs = () => upstream.calls.flatMap((c) => c.rpc);
  beforeEach(() => {
    upstream.state.rpcReplies = {
      get_recommend_feed: { data: { retcode: 0, d_num: 0, load_mark: 0, v_shelf: SHELVES } },
      CgiGetTrackInfo: { data: { tracks: [track(101), track(102), track(103)] } },
    };
  });

  it('reads page 1 with the verified minimal request and keeps songs and 513 playlists only', async () => {
    const result = await call();

    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      code: 200,
      page: 1,
      more: false,
      shelves: [
        {
          id: '9001',
          titleTemplate: 'Hi {String}  今日为你推荐',
          titleContent: 'fixture-nick',
          items: [
            {
              type: 'playlist',
              playlist: {
                id: 700001,
                title: 'card-700001',
                subtitle: 'sub-700001',
                cover: 'https://y.gtimg.cn/fixture-700001.jpg',
              },
            },
            {
              type: 'playlist',
              playlist: {
                id: 700002,
                title: 'card-700002',
                subtitle: 'sub-700002',
                cover: 'https://y.gtimg.cn/fixture-700002.jpg',
              },
            },
          ],
        },
        {
          id: '9002',
          titleTemplate: '心动的歌曲推荐',
          titleContent: 'fixture-seed',
          items: [
            { type: 'song', song: track(101) },
            { type: 'song', song: track(102) },
            { type: 'song', song: track(103) },
          ],
        },
      ],
    });
    const feed = rpcs().find((rpc) => rpc.method === 'get_recommend_feed');
    expect(feed).toMatchObject({
      module: 'music.recommend.RecommendFeed',
      method: 'get_recommend_feed',
    });
    expect(feed?.param).toEqual({
      page: 1,
      direction: 0,
      s_num: 0,
      client_time: expect.any(Number),
      v_cache: [],
      ext: { has_login: '1', phone_language: 'zh-TW', client_time_zone: 'Asia/Taipei' },
    });
    // 同一首只问一次，按卡片的顺序。
    const lookup = rpcs().filter((rpc) => rpc.method === 'CgiGetTrackInfo');
    expect(lookup).toEqual([
      {
        module: 'music.trackInfo.UniformRuleCtrl',
        method: 'CgiGetTrackInfo',
        param: { ids: [101, 102, 103], types: [1, 1, 1] },
      },
    ]);
  });

  it('asks for the tracks 20 ids at a time', async () => {
    const many = Array.from({ length: 25 }, (_, index) => card(200, 10046, 0, String(200 + index)));
    upstream.state.rpcReplies = {
      get_recommend_feed: {
        data: {
          retcode: 0,
          v_shelf: [{ id: 1, title_template: 't', title_content: '', v_niche: [niche(...many)] }],
        },
      },
      CgiGetTrackInfo: {
        data: { tracks: Array.from({ length: 25 }, (_, index) => track(200 + index)) },
      },
    };

    const result = await call();

    expect(result.status).toBe(200);
    expect(feedOf(result).shelves[0].items).toHaveLength(25);
    expect(
      rpcs()
        .filter((rpc) => rpc.method === 'CgiGetTrackInfo')
        .map((rpc) => (rpc.param.ids as number[]).length),
    ).toEqual([20, 5]);
  });

  it('drops a song the track lookup did not answer, and a shelf left with nothing', async () => {
    upstream.state.rpcReplies = {
      get_recommend_feed: { data: { retcode: 0, v_shelf: SHELVES } },
      CgiGetTrackInfo: { data: { tracks: [track(101)] } },
    };

    const result = await call();

    expect(feedOf(result).shelves.map((shelf) => shelf.id)).toEqual(['9001', '9002']);
    expect(feedOf(result).shelves[1].items).toEqual([{ type: 'song', song: track(101) }]);
  });

  it('answers 422 when no shelf has a song or a playlist', async () => {
    upstream.state.rpcReplies = {
      get_recommend_feed: { data: { retcode: 0, v_shelf: [SHELVES[2]] } },
    };

    const result = await call();

    expect(result.status).toBe(422);
    expect(rpcs().map((rpc) => rpc.method)).not.toContain('CgiGetTrackInfo');
  });

  it('keeps a non-zero retcode as a rejection with its code, and a broken page as invalid', async () => {
    upstream.state.rpcReplies = { get_recommend_feed: { data: { retcode: 1234, v_shelf: [] } } };
    const rejected = await call();
    expect(rejected.status).toBe(502);
    expect(rejected.body).toMatchObject({ kind: 'upstream-business', upstreamCode: 1234 });

    upstream.state.rpcReplies = { get_recommend_feed: { data: { retcode: 0, v_shelf: 'x' } } };
    expect((await call()).status).toBe(502);
  });

  it('needs a session and does not retry', async () => {
    expect((await call('missing')).status).toBe(401);
    expect(rpcs()).toEqual([]);
  });
});
