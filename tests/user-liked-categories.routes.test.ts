import {
  CONTRACT_CREDENTIAL,
  type Reply,
  type Runtime,
  setupSessionRoute,
  sharedSessionReadCases,
} from './helpers/newSessionRoute';

// 我喜欢分类（`SongFavCategory.GetCategoryInfo`）：要登录。先分页读「我喜欢」（CgiGetDiss dirid 201，
// 每页 100、最多 500 首），再把歌送去分类（官方 App 的 song_type 是 13）。2026-11 实测回
// t_Suggest／t_Artist／t_Period／t_Genre 四组，歌手组的标题是空的，category_key 是歌手 id。
// 只送了一部分歌、或某一组标了失败，都不能说是完整结果。

const song = (id: number, singers: Array<[number, string]>) => ({
  id,
  mid: `fixtureSong${id}`,
  type: 0,
  name: `Fixture song ${id}`,
  singer: singers.map(([singerId, name]) => ({
    id: singerId,
    mid: `fixtureSinger${singerId}`,
    name,
  })),
});

describe.each(['node', 'serverless'] as Runtime[])('playlist update boundaries: %s', (runtime) => {
  const ctx = setupSessionRoute(runtime, () => ({
    CgiGetPlaylistFavInfo: { data: { total: 1, hasmore: 0, v_list: [{ tid: 1 }] } },
    CgiGetRecentSong: { data: { updateDirs: [] } },
  }));

  it.each([
    ['string hasmore', { total: 1, hasmore: '1', v_list: [{ tid: 1 }] }, 1],
    ['total exceeds sent', { total: 2, v_list: [{ tid: 1 }] }, 1],
    ['invalid ids', { total: 1, v_list: [{ tid: 0 }, {}] }, 0],
    ['duplicate ids', { total: 2, v_list: [{ tid: 1 }, { tid: 1 }] }, 1],
    [
      'over 100 entries',
      { total: 101, v_list: Array.from({ length: 101 }, (_, i) => ({ tid: i + 1 })) },
      100,
    ],
  ])('marks %s incomplete and sends at most unique 100', async (_name, data, checked) => {
    ctx.replies.CgiGetPlaylistFavInfo = { data };
    const result = await ctx.call('/user/playlist/updates', { token: ctx.token });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ checked, complete: false });
    if (checked)
      expect(ctx.recorded[1].rpcs[0].param.clientOrderDirs as unknown[]).toHaveLength(checked);
    else expect(ctx.recorded).toHaveLength(1);
  });

  it.each([
    [[123], 200],
    [{}, 502],
    [null, 502],
  ])('handles failed ids %s', async (failed, status) => {
    ctx.replies.CgiGetRecentSong = { data: { updateDirs: [], v_failTids: failed } };
    const result = await ctx.call('/user/playlist/updates', { token: ctx.token });
    expect(result.status).toBe(status);
    if (status === 200) expect(result.body.complete).toBe(false);
    else expect(result.body.errorKey).toBe('upstream.invalid-response');
  });
});
const likedPage = (ids: number[], total: unknown) => ({
  code: 0,
  subcode: 0,
  total_song_num: total,
  songlist: ids.map((id) => song(id, [[600 + (id % 2), `Fixture singer ${600 + (id % 2)}`]])),
});
const category = (overrides: Record<string, unknown>) => ({
  title: '',
  id: 0,
  text: '',
  list: [{ song_id: 1, song_type: 13, nPlay: 3 }],
  ext: { label: 'fixture-private-label' },
  category_key: '',
  ...overrides,
});
const CATEGORIES = {
  code: 0,
  subcode: 0,
  t_Suggest: {
    title: 'Fixture suggest',
    id: 1,
    fail: false,
    list: [category({ id: 11, title: 'Fixture recent' })],
  },
  t_Artist: {
    title: 'Fixture artist',
    id: 2,
    fail: false,
    list: [category({ id: 21, category_key: '600' }), category({ id: 22, category_key: '999' })],
  },
  t_Period: {
    title: 'Fixture period',
    id: 3,
    fail: false,
    list: [category({ id: 31, title: '2026-11', category_key: '202611' })],
  },
  t_Genre: {
    title: 'Fixture genre',
    id: 4,
    fail: false,
    list: [category({ id: 41, title: 'Pop', category_key: '1' })],
  },
  detail: { 1: { tFirstFav: 1, nPlay: 3 } },
};
const defaults = (): Record<string, Reply> => ({
  CgiGetDiss: { data: likedPage([1, 2, 3], 3) },
  GetCategoryInfo: { data: CATEGORIES },
});

describe.each(['node', 'serverless'] as Runtime[])('liked song categories route: %s', (runtime) => {
  const ctx = setupSessionRoute(runtime, defaults);
  sharedSessionReadCases(runtime, ctx, '/user/liked-songs/categories', 'GetCategoryInfo');

  it('deduplicates songs across pages before deciding the total is reached', async () => {
    let page = 0;
    const pages = [
      Array.from({ length: 100 }, (_, i) => i + 1),
      [...Array.from({ length: 99 }, (_, i) => i + 2), 101],
      [102],
    ];
    Object.defineProperty(ctx.replies, 'CgiGetDiss', {
      configurable: true,
      get: () => ({ data: likedPage(pages[page++] ?? [], 102) }),
    });
    const result = await ctx.call('/user/liked-songs/categories', { token: ctx.token });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ checkedSongs: 102, totalSongs: 102, complete: true });
    const sent = ctx.recorded.find((item) => item.rpcs[0].method === 'GetCategoryInfo');
    expect((sent?.rpcs[0].param.songlist as { song_id: number }[]).map((s) => s.song_id)).toEqual(
      Array.from({ length: 102 }, (_, i) => i + 1),
    );
  });

  it('rejects a grouping response without any group after sending songs', async () => {
    ctx.replies.GetCategoryInfo = { data: {} };
    const result = await ctx.call('/user/liked-songs/categories', { token: ctx.token });
    expect(result.status).toBe(502);
    expect(result.body.errorKey).toBe('upstream.invalid-response');
  });

  it('reads every liked song, sends them for grouping and fills singer names from the same songs', async () => {
    const result = await ctx.call('/user/liked-songs/categories', { token: ctx.token });

    expect(result.status).toBe(200);
    expect(result.headers['cache-control']).toBe('private, no-store');
    expect(result.body).toEqual({
      code: 200,
      groups: [
        {
          type: 'suggest',
          title: 'Fixture suggest',
          categories: [{ id: 11, key: '', title: 'Fixture recent', songIds: [1] }],
        },
        {
          type: 'artist',
          title: 'Fixture artist',
          categories: [
            { id: 21, key: '600', title: 'Fixture singer 600', songIds: [1] },
            { id: 22, key: '999', title: '', songIds: [1] },
          ],
        },
        {
          type: 'period',
          title: 'Fixture period',
          categories: [{ id: 31, key: '202611', title: '2026-11', songIds: [1] }],
        },
        {
          type: 'genre',
          title: 'Fixture genre',
          categories: [{ id: 41, key: '1', title: 'Pop', songIds: [1] }],
        },
      ],
      checkedSongs: 3,
      totalSongs: 3,
      complete: true,
    });
    expect(ctx.recorded.map((item) => item.rpcs[0].method)).toEqual([
      'CgiGetDiss',
      'GetCategoryInfo',
    ]);
    expect(ctx.recorded[0].rpcs[0]).toEqual({
      module: 'music.srfDissInfo.DissInfo',
      method: 'CgiGetDiss',
      param: {
        disstid: 0,
        dirid: 201,
        tag: true,
        song_begin: 0,
        song_num: 100,
        userinfo: true,
        orderlist: true,
        enc_host_uin: CONTRACT_CREDENTIAL.encryptUin,
      },
    });
    expect(ctx.recorded[1].rpcs[0]).toEqual({
      module: 'music.mobileAsset.SongFavCategory',
      method: 'GetCategoryInfo',
      param: {
        songlist: [
          { song_id: 1, song_type: 13, singers_id: [601] },
          { song_id: 2, song_type: 13, singers_id: [600] },
          { song_id: 3, song_type: 13, singers_id: [601] },
        ],
      },
    });
    for (const item of ctx.recorded) expect(item.comm).toMatchObject({ ct: 11 });
    expect(JSON.stringify(result.body)).not.toContain('fixture-private');
  });

  it('stops at 500 songs and says complete:false when there are more', async () => {
    let page = 0;
    const ids = (start: number) => Array.from({ length: 100 }, (_, index) => start + index);
    const pages = [ids(1), ids(101), ids(201), ids(301), ids(401), ids(501)];
    Object.defineProperty(ctx.replies, 'CgiGetDiss', {
      configurable: true,
      enumerable: true,
      get: () => ({ data: likedPage(pages[page++] ?? [], 650) }),
    });

    const result = await ctx.call('/user/liked-songs/categories', { token: ctx.token });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ checkedSongs: 500, totalSongs: 650, complete: false });
    const begins = ctx.recorded
      .filter((item) => item.rpcs[0].method === 'CgiGetDiss')
      .map((item) => item.rpcs[0].param.song_begin);
    expect(begins).toEqual([0, 100, 200, 300, 400]);
    const sent = ctx.recorded.find((item) => item.rpcs[0].method === 'GetCategoryInfo');
    expect((sent?.rpcs[0].param.songlist as unknown[]).length).toBe(500);
  });

  it('a short page before the total stops reading and is not called complete', async () => {
    ctx.replies.CgiGetDiss = { data: likedPage([1, 2], 10) };

    const result = await ctx.call('/user/liked-songs/categories', { token: ctx.token });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ checkedSongs: 2, totalSongs: 10, complete: false });
  });

  it('marks a group the service flagged as failed and is then not complete', async () => {
    ctx.replies.GetCategoryInfo = {
      data: { ...CATEGORIES, t_Genre: { title: 'Fixture genre', id: 4, fail: true, list: null } },
    };

    const result = await ctx.call('/user/liked-songs/categories', { token: ctx.token });

    expect(result.status).toBe(200);
    expect(result.body.groups[3]).toEqual({
      type: 'genre',
      title: 'Fixture genre',
      failed: true,
      categories: [],
    });
    expect(result.body.complete).toBe(false);
  });

  it('with no liked song it does not ask for grouping', async () => {
    ctx.replies.CgiGetDiss = { data: likedPage([], 0) };

    const result = await ctx.call('/user/liked-songs/categories', { token: ctx.token });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      code: 200,
      groups: [],
      checkedSongs: 0,
      totalSongs: 0,
      complete: true,
    });
    expect(ctx.recorded).toHaveLength(1);
  });

  it('without a readable total it cannot claim completeness', async () => {
    ctx.replies.CgiGetDiss = { data: likedPage([1], '1') };

    const result = await ctx.call('/user/liked-songs/categories', { token: ctx.token });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ checkedSongs: 1, totalSongs: null, complete: false });
  });

  it.each([
    [
      'a liked page that is not a list',
      { CgiGetDiss: { data: { total_song_num: 3, songlist: {} } } },
    ],
    [
      'a group block that is not an object',
      { GetCategoryInfo: { data: { ...CATEGORIES, t_Artist: 'x' } } },
    ],
    [
      'a category list that is not a list',
      { GetCategoryInfo: { data: { ...CATEGORIES, t_Period: { title: 'x', list: {} } } } },
    ],
    ['a non-object grouping payload', { GetCategoryInfo: { data: 'x' } }],
  ])('answers 502 for %s', async (_label, override) => {
    Object.assign(ctx.replies, override);

    const result = await ctx.call('/user/liked-songs/categories', { token: ctx.token });

    expect(result.status).toBe(502);
    expect(result.body.errorKey).toBe('upstream.invalid-response');
  });

  it('a non-zero code inside the grouping data is an upstream failure', async () => {
    ctx.replies.GetCategoryInfo = { data: { ...CATEGORIES, subcode: 2001 } };

    const result = await ctx.call('/user/liked-songs/categories', { token: ctx.token });

    expect(result.status).toBe(502);
    expect(result.body).toMatchObject({ errorKey: 'upstream.unknown', upstreamCode: 2001 });
  });

  it('a rejected credential while reading the liked songs answers 401', async () => {
    ctx.replies.CgiGetDiss = { code: 1000 };

    const result = await ctx.call('/user/liked-songs/categories', { token: ctx.token });

    expect(result.status).toBe(401);
  });
});
