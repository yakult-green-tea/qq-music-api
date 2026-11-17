import {
  CONTRACT_CREDENTIAL,
  type Reply,
  type Runtime,
  setupSessionRoute,
  sharedSessionReadCases,
} from './helpers/newSessionRoute';

// 听歌报告（`ListenReportSvr.GetBar`）：要登录，和 `/user/listening-rank`（GetRank，歌曲排行）分开。
// 2026-11 带会话实测：`listenTime.listenTimeSec` 当天的值等于好友日榜和音乐力的当天秒数；
// `percent`、`upOrDown` 对不上两周秒数的变化或比例，意义不明，不交出。年报告的 date 是 YYYY。

const REPORT = {
  availableDates: ['202610', '202611', 7],
  options: [{ type: 1, name: 'fixture' }],
  listenTime: { listenTimeSec: 3600, listenCnt: 42, upOrDown: 2, percent: 37, activeHour: 22 },
  bar: {
    optionResults: {
      '202611': [{ id: 9, name: 'Fixture b', value: 5, rank: 2, value2: 1, singerAvatar: '' }],
      '202610': [
        { id: 8, name: 'Fixture a', value: 7, rank: 1, value2: 0, singerAvatar: '' },
        { id: 0, name: 'x' },
      ],
    },
  },
  highLights: [
    {
      type: 1,
      title: 'Fixture title',
      subtitle: 'Fixture sub',
      tips: 'fixture-private-tips',
      cover: 'x',
      value: 3,
    },
    null,
  ],
  userInfo: { uin: 'fixture-private-uin', nick: 'fixture-private-nick' },
  token: 'fixture-private-token',
  textBlock: { text: 'fixture-private-text' },
};
const defaults = (): Record<string, Reply> => ({ GetBar: { data: REPORT } });

describe.each(['node', 'serverless'] as Runtime[])('listening report route: %s', (runtime) => {
  const ctx = setupSessionRoute(runtime, defaults);
  sharedSessionReadCases(runtime, ctx, '/user/listening-report?range=week', 'GetBar');

  it('keeps null periods as empty items in a sorted weekly chart', async () => {
    ctx.replies.GetBar = {
      data: {
        ...REPORT,
        bar: {
          optionResults: {
            '20261102': [{ id: 8, name: 'Fixture a', value: 7 }],
            '20261101': null,
          },
        },
      },
    };
    const result = await ctx.call('/user/listening-report?range=week', { token: ctx.token });
    expect(result.status).toBe(200);
    expect(result.body.chart).toEqual([
      { period: '20261101', items: [] },
      { period: '20261102', items: [{ id: 8, name: 'Fixture a', value: 7 }] },
    ]);
  });

  it.each(['bad', {}])('rejects a non-array non-null period %p', async (period) => {
    ctx.replies.GetBar = { data: { ...REPORT, bar: { optionResults: { '20261101': period } } } };
    const result = await ctx.call('/user/listening-report?range=week', { token: ctx.token });
    expect(result.status).toBe(502);
    expect(result.body.errorKey).toBe('upstream.invalid-response');
  });

  it.each([
    'listenTime',
    'bar',
    'highLights',
    'availableDates',
  ])('rejects a malformed %s', async (field) => {
    ctx.replies.GetBar = { data: { ...REPORT, [field]: 'bad' } };
    const result = await ctx.call('/user/listening-report?range=week', { token: ctx.token });
    expect(result.status).toBe(502);
    expect(result.body.errorKey).toBe('upstream.invalid-response');
  });

  it('accepts null report fields as empty', async () => {
    ctx.replies.GetBar = {
      data: { listenTime: null, bar: null, highLights: null, availableDates: null },
    };
    const result = await ctx.call('/user/listening-report?range=week', { token: ctx.token });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ chart: [], highlights: [], availableDates: [] });
  });

  it.each([
    '/user/listening-report',
    '/user/listening-report?range=all',
    '/user/listening-report?range=week&range=day',
    '/user/listening-report?range=day&date=20261131',
    '/user/listening-report?range=week&date=202611',
    '/user/listening-report?range=month&date=202613',
    '/user/listening-report?range=year&date=26',
    '/user/listening-report?range=year&date=2026&date=2025',
  ])('%s answers 400 without reaching the upstream', async (path) => {
    const result = await ctx.call(path, { token: ctx.token });

    expect(result.status).toBe(400);
    expect(result.body.errorKey).toBe('input.invalid');
    expect(ctx.recorded).toEqual([]);
  });

  it('reads the report once and leaves out the fields whose meaning is unknown', async () => {
    const result = await ctx.call('/user/listening-report?range=month', { token: ctx.token });

    expect(result.status).toBe(200);
    expect(result.headers['cache-control']).toBe('private, no-store');
    expect(result.body).toEqual({
      code: 200,
      range: 'month',
      availableDates: ['202610', '202611'],
      listenSeconds: 3600,
      listenCount: 42,
      activeHour: 22,
      chart: [
        { period: '202610', items: [{ id: 8, name: 'Fixture a', value: 7, rank: 1 }] },
        { period: '202611', items: [{ id: 9, name: 'Fixture b', value: 5, rank: 2 }] },
      ],
      highlights: [{ type: 1, title: 'Fixture title', subtitle: 'Fixture sub', value: 3 }],
    });
    expect(ctx.recorded[0].rpcs).toEqual([
      {
        module: 'music.individuation.ListenReportSvr',
        method: 'GetBar',
        param: { type: 3, optionType: 1, token: '', uin: '', version: 'v2' },
      },
    ]);
    expect(ctx.recorded[0].comm).toMatchObject({ ct: 11, authst: CONTRACT_CREDENTIAL.musickey });
    const text = JSON.stringify(result.body);
    expect(text).not.toContain('fixture-private');
    expect(text).not.toContain('percent');
    expect(text).not.toContain('upOrDown');
  });

  it.each([
    ['day', '20261116', 1],
    ['week', '20261109', 2],
    ['month', '202610', 3],
    ['year', '2025', 4],
  ])('range=%s with date %s asks type %i for that period', async (range, date, type) => {
    const result = await ctx.call(`/user/listening-report?range=${range}&date=${date}`, {
      token: ctx.token,
    });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ range, date });
    expect(ctx.recorded[0].rpcs[0].param).toEqual({
      type,
      date,
      optionType: 1,
      token: '',
      uin: '',
      version: 'v2',
    });
  });

  it('a period without listening keeps whatever numbers are readable and empty lists', async () => {
    ctx.replies.GetBar = {
      data: { listenTime: { listenTimeSec: 0, listenCnt: '0' }, bar: { optionResults: null } },
    };

    const result = await ctx.call('/user/listening-report?range=day', { token: ctx.token });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      code: 200,
      range: 'day',
      availableDates: [],
      listenSeconds: 0,
      chart: [],
      highlights: [],
    });
  });

  it.each([
    ['a non-object chart', { ...REPORT, bar: { optionResults: [] } }],
    ['a non-list period', { ...REPORT, bar: { optionResults: { '202611': {} } } }],
    ['a non-object payload', 'x'],
  ])('answers 502 for %s', async (_label, data) => {
    ctx.replies.GetBar = { data };

    const result = await ctx.call('/user/listening-report?range=week', { token: ctx.token });

    expect(result.status).toBe(502);
    expect(result.body.errorKey).toBe('upstream.invalid-response');
  });
});
