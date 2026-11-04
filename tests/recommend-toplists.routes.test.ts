import request from 'supertest';
import app from '../src/app';
import { handleRequest } from '../src/serverless';
import { logger } from '../src/util/logger';

// 排行榜：榜单清单与单榜歌曲，都匿名读。Node 与 serverless 跑同一份案例，只替换对外的 fetch。
// 结构按 2026-10 实测整理（官方网页送的是 `musicToplist.ToplistInfoServer` 与全小写的 `topid`），
// 名称与 id 都是假数据。

interface Rpc {
  module: string;
  method: string;
  param: Record<string, unknown>;
}
interface Recorded {
  comm: Record<string, unknown>;
  cookie: string | null;
  rpcs: Rpc[];
}
interface Reply {
  httpStatus?: number;
  globalCode?: number;
  code?: number;
  data?: unknown;
}
interface HttpResult {
  status: number;
  body: Record<string, any>;
}

const preview = (rank: number) => ({
  rank,
  rankType: 1,
  rankValue: '',
  title: `Fixture chart song ${rank}`,
  singerName: `Fixture singer ${rank}`,
  singerMid: `fixture-singer-${rank}`,
  songId: 900 + rank,
  albumMid: `fixture-album-${rank}`,
  cover: 'https://y.gtimg.cn/fixture-song-cover.jpg',
  mvid: 0,
  vid: '',
  songType: 0,
  recType: 0,
  uuidCnt: 0,
});

const chart = (topId: unknown, overrides: Record<string, unknown> = {}) => ({
  topId,
  topType: 0,
  title: `Fixture chart ${String(topId)}`,
  titleDetail: '',
  titleSub: '',
  intro: 'Fixture intro',
  period: '2026-10-17',
  updateType: 1,
  updateTime: '2026-10-17',
  totalNum: 100,
  listenNum: 4321,
  headPicUrl: 'https://y.gtimg.cn/fixture-head.jpg',
  frontPicUrl: 'https://y.gtimg.cn/fixture-front.jpg',
  musichallPicUrl: 'https://y.gtimg.cn/fixture-musichall.jpg',
  history: { year: [], subPeriod: [] },
  song: [preview(1), preview(2)],
  ...overrides,
});

const flattenedChart = (id: number) => ({
  id,
  title: `Fixture chart ${id}`,
  intro: 'Fixture intro',
  period: '2026-10-17',
  updateType: 1,
  updateTime: '2026-10-17',
  total: 100,
  listenNum: 4321,
  cover: 'https://y.gtimg.cn/fixture-head.jpg',
  preview: [
    { rank: 1, title: 'Fixture chart song 1', singer: 'Fixture singer 1' },
    { rank: 2, title: 'Fixture chart song 2', singer: 'Fixture singer 2' },
  ],
});

const GROUPS = {
  abt: '',
  refreshInterval: 0,
  location: { province: { name: '', pinyin: '', provinceID: 0 } },
  group: [
    { groupId: 1, groupName: 'Fixture peak', type: 0, toplist: [chart(4), chart(26)] },
    { groupId: 2, groupName: 'Fixture region', type: 0, toplist: [chart(201, { period: '' })] },
  ],
};

const SONGS = [
  { id: 301, mid: 'fixture-chart-a', name: 'Fixture chart song A' },
  { id: 302, mid: 'fixture-chart-b', name: 'Fixture chart song B' },
];
const DETAIL = {
  data: chart(26),
  songInfoList: SONGS,
  songTagInfoList: null,
  extInfoList: [],
  indexInfoList: null,
};

describe.each(['node', 'serverless'] as const)('toplist routes: %s', (runtime) => {
  let recorded: Recorded[];
  let replies: Record<string, Reply>;

  const upstream = async (input: string | URL | Request, init?: RequestInit) => {
    const fetched = new Request(input, init);
    const url = new URL(fetched.url);
    if (url.hostname !== 'u.y.qq.com' || url.pathname !== '/cgi-bin/musicu.fcg')
      throw new Error(`Unstubbed request: ${url.origin}${url.pathname}`);
    const payload = JSON.parse(await fetched.text());
    const rpcs: Rpc[] = Object.entries(payload)
      .filter(([key]) => key.startsWith('req_'))
      .map(([, value]) => value as Rpc);
    recorded.push({ comm: payload.comm, cookie: fetched.headers.get('cookie'), rpcs });
    const reply = replies[rpcs[0]?.method] ?? {};
    if (reply.httpStatus && reply.httpStatus >= 400)
      return new Response('fixture-private-error-page', { status: reply.httpStatus });
    return Response.json({
      code: reply.globalCode ?? 0,
      req_0: { code: reply.code ?? 0, data: reply.data ?? {} },
    });
  };

  const call = async (path: string, headers: Record<string, string> = {}): Promise<HttpResult> => {
    if (runtime === 'node') {
      const result = await request(app.callback()).get(path).set(headers);
      return { status: result.status, body: result.body };
    }
    // 没设会话密钥也要能读：排行榜不需要登录。
    const result = await handleRequest(
      new Request(`https://catalog.invalid${path}`, { headers }),
      {},
    );
    return { status: result.status, body: (await result.json()) as HttpResult['body'] };
  };

  beforeEach(() => {
    for (const level of ['debug', 'warn', 'error'] as const)
      jest.spyOn(logger, level).mockImplementation(() => undefined);
    jest.spyOn(global, 'fetch').mockImplementation(upstream);
    app.silent = true;
    recorded = [];
    replies = { GetAll: { data: GROUPS }, GetDetail: { data: DETAIL } };
  });

  afterEach(() => jest.restoreAllMocks());

  it.each([
    '/recommend/toplists',
    '/recommend/toplist?id=26',
  ])('%s reads anonymously with the web comm even when a session is sent', async (path) => {
    const result = await call(path, { 'X-QQ-Session': 'b'.repeat(64) });

    expect(result.status).toBe(200);
    expect(recorded).toHaveLength(1);
    expect(recorded[0].comm).toEqual({ ct: 24, cv: 0 });
    expect(recorded[0].cookie).toBeNull();
  });

  describe('/recommend/toplists', () => {
    it('flattens the groups and their charts', async () => {
      const result = await call('/recommend/toplists');

      expect(result.status).toBe(200);
      expect(result.body).toEqual({
        code: 200,
        groups: [
          { id: 1, name: 'Fixture peak', toplists: [flattenedChart(4), flattenedChart(26)] },
          {
            id: 2,
            name: 'Fixture region',
            toplists: [(({ period: _period, ...rest }) => rest)(flattenedChart(201))],
          },
        ],
      });
      expect(recorded[0].rpcs).toEqual([
        { module: 'musicToplist.ToplistInfoServer', method: 'GetAll', param: {} },
      ]);
    });

    // 上游第一组「巅峰榜」的 groupId 是 0：组 id 允许 0，榜单自己的 id 仍要正整数。
    it('keeps the group whose id is 0 and drops groups with a negative or non-integer id', async () => {
      replies.GetAll = {
        data: {
          group: [
            { groupId: 0, groupName: 'Fixture peak', toplist: [chart(4)] },
            { groupId: 1, groupName: 'Fixture region', toplist: [chart(5)] },
            { groupId: -1, groupName: 'Fixture negative', toplist: [chart(6)] },
            { groupId: 1.5, groupName: 'Fixture fraction', toplist: [chart(7)] },
            { groupId: '2', groupName: 'Fixture text', toplist: [chart(8)] },
          ],
        },
      };

      const result = await call('/recommend/toplists');

      expect(result.status).toBe(200);
      expect(
        result.body.groups.map((group: { id: number; name: string }) => [group.id, group.name]),
      ).toEqual([
        [0, 'Fixture peak'],
        [1, 'Fixture region'],
      ]);
    });

    it('skips charts without a usable id, leaves bad fields out and drops empty groups', async () => {
      replies.GetAll = {
        data: {
          group: [
            {
              groupId: 1,
              groupName: 'Fixture peak',
              toplist: [
                chart(0),
                chart('26'),
                chart(27, {
                  intro: 7,
                  totalNum: -1,
                  listenNum: 1.5,
                  headPicUrl: '',
                  frontPicUrl: 'https://y.gtimg.cn/fixture-front.jpg',
                  song: [preview(1), { rank: 'x' }, null],
                }),
              ],
            },
            { groupId: 3, groupName: 'Fixture empty', toplist: [chart(-2)] },
          ],
        },
      };

      const result = await call('/recommend/toplists');

      expect(result.status).toBe(200);
      expect(result.body.groups).toEqual([
        {
          id: 1,
          name: 'Fixture peak',
          toplists: [
            {
              id: 27,
              title: 'Fixture chart 27',
              period: '2026-10-17',
              updateType: 1,
              updateTime: '2026-10-17',
              cover: 'https://y.gtimg.cn/fixture-front.jpg',
              preview: [{ rank: 1, title: 'Fixture chart song 1', singer: 'Fixture singer 1' }],
            },
          ],
        },
      ]);
    });

    it.each([
      ['no charts', { group: [] }, 422, 'resource.not-found'],
      ['a non-list', { group: {} }, 502, 'upstream.invalid-response'],
    ])('answers for %s', async (_label, data, status, errorKey) => {
      replies.GetAll = { data };

      const result = await call('/recommend/toplists');

      expect(result.status).toBe(status);
      expect(result.body.errorKey).toBe(errorKey);
    });
  });

  describe('/recommend/toplist', () => {
    it('可选排名按歌曲编号交出，不按歌曲数组下标配对', async () => {
      replies.GetDetail = {
        data: {
          ...DETAIL,
          data: chart(26, {
            song: [{ songId: 302, rank: 3, rankType: 1, rankValue: '2' }],
            history: { year: [], subPeriod: [] },
          }),
        },
      };
      const result = await call('/recommend/toplist?id=26');
      expect(result.body.songs).toEqual(SONGS);
      expect(result.body.ranks).toEqual([{ songId: 302, rank: 3, rankType: 1, rankValue: '2' }]);
      expect(result.body.history).toEqual({ year: [], subPeriod: [] });
      expect(recorded).toHaveLength(1);
    });

    it('缺少或损坏可选元数据不改变原有成功结果', async () => {
      replies.GetDetail = { data: { ...DETAIL, data: chart(26, { song: {}, history: null }) } };
      const result = await call('/recommend/toplist?id=26');
      expect(result.status).toBe(200);
      expect(result.body.songs).toEqual(SONGS);
      expect(result.body.ranks).toBeUndefined();
      expect(result.body.history).toBeUndefined();
    });

    it('往期条目按上游形状保留，非空条目只有离线覆盖', async () => {
      const history = { year: [2025, 2026], subPeriod: [{ period: '2026_41', name: '测试期别' }] };
      replies.GetDetail = { data: { ...DETAIL, data: chart(26, { history }) } };
      expect((await call('/recommend/toplist?id=26')).body.history).toEqual(history);
    });

    it('returns the chart, its songs unchanged and whether more follow; latest period by default', async () => {
      const result = await call('/recommend/toplist?id=26');

      expect(result.status).toBe(200);
      expect(result.body).toEqual({
        code: 200,
        toplist: (({ preview: _preview, ...rest }) => rest)(flattenedChart(26)),
        songs: SONGS,
        total: 100,
        more: true,
        ranks: [1, 2].map((rank) => ({ songId: 900 + rank, rank, rankType: 1, rankValue: '' })),
        history: { year: [], subPeriod: [] },
      });
      expect(recorded[0].rpcs).toEqual([
        {
          module: 'musicToplist.ToplistInfoServer',
          method: 'GetDetail',
          param: { topid: 26, offset: 0, num: 20, period: '' },
        },
      ]);
    });

    it.each([
      ['&period=2026_41&offset=20&limit=30', 20, 30, '2026_41'],
      ['&period=2026-10-16', 0, 20, '2026-10-16'],
      ['&limit=1000&offset=-5', 0, 100, ''],
      ['&limit=abc&offset=abc', 0, 20, ''],
    ])('reads %s as offset %d, size %d and period %s', async (query, offset, num, period) => {
      await call(`/recommend/toplist?id=26${query}`);

      expect(recorded[0].rpcs[0].param).toEqual({ topid: 26, offset, num, period });
    });

    it('reports no more songs at the end of the chart', async () => {
      replies.GetDetail = { data: { ...DETAIL, data: chart(26, { totalNum: 22 }) } };

      const result = await call('/recommend/toplist?id=26&offset=20');

      expect(result.body.total).toBe(22);
      expect(result.body.more).toBe(false);
    });

    it('leaves total out and reports no more when the chart has no usable count', async () => {
      replies.GetDetail = { data: { ...DETAIL, data: chart(26, { totalNum: '100' }) } };

      const result = await call('/recommend/toplist?id=26');

      expect(result.body).not.toHaveProperty('total');
      expect(result.body.more).toBe(false);
    });

    it.each([
      '',
      '?id=',
      '?id=abc',
      '?id=0',
      '?id=26&period=2026%2F10',
      `?id=26&period=${'1'.repeat(21)}`,
    ])('answers 400 for a malformed query %s without reaching the upstream', async (query) => {
      const result = await call(`/recommend/toplist${query}`);

      expect(result.status).toBe(400);
      expect(result.body.errorKey).toBe('input.invalid');
      expect(recorded).toEqual([]);
    });

    it.each([
      ['no songs', { ...DETAIL, songInfoList: [] }, 422, 'resource.not-found'],
      ['a non-list', { ...DETAIL, songInfoList: {} }, 502, 'upstream.invalid-response'],
      ['no chart data', { ...DETAIL, data: null }, 502, 'upstream.invalid-response'],
    ])('answers for %s', async (_label, data, status, errorKey) => {
      replies.GetDetail = { data };

      const result = await call('/recommend/toplist?id=26');

      expect(result.status).toBe(status);
      expect(result.body.errorKey).toBe(errorKey);
    });
  });

  it.each([
    ['GetAll', '/recommend/toplists'],
    ['GetDetail', '/recommend/toplist?id=26'],
  ])('%s: an upstream business code becomes 502 and keeps the number', async (method, path) => {
    replies[method] = { code: 1000 };

    const result = await call(path);

    expect(result.status).toBe(502);
    expect(result.body).toMatchObject({ errorKey: 'upstream.unknown', upstreamCode: 1000 });
  });

  it('answers 502 without the error page when the upstream HTTP request fails', async () => {
    replies.GetDetail = { httpStatus: 503 };

    const result = await call('/recommend/toplist?id=26');

    expect(result.status).toBe(502);
    expect(JSON.stringify(result.body)).not.toContain('fixture-private-error-page');
  });
});
