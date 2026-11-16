import {
  CONTRACT_CREDENTIAL,
  type Reply,
  type Runtime,
  setupSessionRoute,
  sharedSessionReadCases,
} from './helpers/newSessionRoute';

// 热搜分类（`HotkeyService.GetHotkeyAllBusinessForQQMusicMobile`）：要登录。
// 形状按 2026-11 带会话实测：`map_business_hotkey` 以业务键分组，每组有中英文名、`show_order` 和 30 个热搜词；
// 另有广告、功能入口、推荐词，都不交出。免费账号见过 5 组、绿钻 6 组，只是观察，不代表会员限制。

const hotkey = (n: number) => ({
  query: ` fixture keyword ${n} `,
  title: `Fixture title ${n}`,
  description: `Fixture description ${n}`,
  jump_url: 'https://y.qq.com/fixture-private-jump',
  hotkey_id: `fixture-${n}`,
});
const group = (cn: string, en: string, order: number, keys: unknown[]) => ({
  tabname_cn: cn,
  tabname_en: en,
  show_order: order,
  search_ext: 'fixture-private-ext',
  vec_hotkey: keys,
});
const ALL = {
  ads: { vec_ads: [{ fixture: 'fixture-private-ad' }] },
  functions: { vec_func: [{ jump_url: 'https://y.qq.com/fixture-private-func' }] },
  business_en_cn: [],
  map_business_hotkey: {
    weibo: group('Fixture weibo', 'weibo', 3, [hotkey(3)]),
    hotkey: group('Fixture hot', 'hotkey', 1, [hotkey(1), hotkey(2)]),
  },
  vec_reckey: [{ query: 'fixture-private-reckey' }],
};
const defaults = (): Record<string, Reply> => ({
  GetHotkeyAllBusinessForQQMusicMobile: { data: ALL },
});

describe.each(['node', 'serverless'] as Runtime[])('hot search categories route: %s', (runtime) => {
  const ctx = setupSessionRoute(runtime, defaults);
  sharedSessionReadCases(
    runtime,
    ctx,
    '/search/hot/categories',
    'GetHotkeyAllBusinessForQQMusicMobile',
  );

  it('returns every category in display order with the same keyword shape as /search/hot', async () => {
    const result = await ctx.call('/search/hot/categories', { token: ctx.token });

    expect(result.status).toBe(200);
    expect(result.headers['cache-control']).toBe('private, no-store');
    expect(result.body).toEqual({
      code: 200,
      categories: [
        {
          key: 'hotkey',
          name: 'Fixture hot',
          nameEn: 'hotkey',
          hotkeys: [
            {
              keyword: 'fixture keyword 1',
              title: 'Fixture title 1',
              description: 'Fixture description 1',
            },
            {
              keyword: 'fixture keyword 2',
              title: 'Fixture title 2',
              description: 'Fixture description 2',
            },
          ],
        },
        {
          key: 'weibo',
          name: 'Fixture weibo',
          nameEn: 'weibo',
          hotkeys: [
            {
              keyword: 'fixture keyword 3',
              title: 'Fixture title 3',
              description: 'Fixture description 3',
            },
          ],
        },
      ],
    });
    expect(ctx.recorded).toHaveLength(1);
    const [rpc] = ctx.recorded[0].rpcs;
    expect(rpc.module).toBe('music.musicsearch.HotkeyService');
    expect(rpc.method).toBe('GetHotkeyAllBusinessForQQMusicMobile');
    expect(rpc.param).toMatchObject({
      from: '1,',
      start: '0',
      need_allhotkey: 1,
      need_reckey: 1,
      need_track_info: 1,
      default_key: [],
      history_query: [],
      custom_flag: '',
    });
    expect(rpc.param.searchid).toMatch(/^[1-9]\d{17}$/);
    expect(ctx.recorded[0].comm).toMatchObject({ ct: 11, authst: CONTRACT_CREDENTIAL.musickey });
    expect(JSON.stringify(result.body)).not.toContain('fixture-private');
  });

  it('skips groups without a readable keyword and keeps the rest', async () => {
    ctx.replies.GetHotkeyAllBusinessForQQMusicMobile = {
      data: {
        map_business_hotkey: {
          broken: group('Fixture broken', 'broken', 1, [{ query: '  ' }, null]),
          hotkey: group('Fixture hot', 'hotkey', 2, [hotkey(1)]),
          odd: 'x',
        },
      },
    };

    const result = await ctx.call('/search/hot/categories', { token: ctx.token });

    expect(result.status).toBe(200);
    expect(result.body.categories.map((item: { key: string }) => item.key)).toEqual(['hotkey']);
  });

  it.each([
    ['an empty map', { map_business_hotkey: {} }],
    ['no map', {}],
  ])('no category (%s) is a normal empty list', async (_label, data) => {
    ctx.replies.GetHotkeyAllBusinessForQQMusicMobile = { data };

    const result = await ctx.call('/search/hot/categories', { token: ctx.token });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ code: 200, categories: [] });
  });

  it.each([
    ['a non-object map', { map_business_hotkey: [] }],
    ['nothing readable', { map_business_hotkey: { hotkey: group('x', 'x', 1, [null]) } }],
    ['a non-object payload', 'x'],
  ])('answers 502 for %s instead of an empty list', async (_label, data) => {
    ctx.replies.GetHotkeyAllBusinessForQQMusicMobile = { data };

    const result = await ctx.call('/search/hot/categories', { token: ctx.token });

    expect(result.status).toBe(502);
    expect(result.body.errorKey).toBe('upstream.invalid-response');
  });
});
