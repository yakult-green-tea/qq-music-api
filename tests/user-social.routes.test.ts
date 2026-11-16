import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  CONTRACT_CREDENTIAL,
  type Reply,
  type Runtime,
  setupSessionRoute,
  sharedSessionReadCases,
} from './helpers/newSessionRoute';

describe('compat approval boundaries', () => {
  const source = readFileSync(resolve('scripts/compat/check.js'), 'utf8');
  const predicate = source.slice(
    source.indexOf('const approvalOf ='),
    source.indexOf('const firstDifference ='),
  );
  const build = (difference: string) =>
    new Function('approved', 'baselineVersion', `${predicate}; return approvalOf;`)(
      [{ path: '/fixture', difference }],
      '3.3.7',
    );
  const before = { status: 404, upstream: [] };
  const testCase = { path: '/fixture', method: 'GET', runtime: 'node', session: false };

  it('rejects anonymous session routes that call upstream or allow caching', () => {
    const approval = build('new-session-route');
    expect(
      approval(testCase, before, { status: 401, upstream: [{}], headers: {} }),
    ).toBeUndefined();
    expect(
      approval(testCase, before, {
        status: 401,
        upstream: [],
        headers: { 'cache-control': 'public' },
      }),
    ).toBeUndefined();
    expect(
      approval(testCase, before, {
        status: 401,
        upstream: [],
        headers: { 'cache-control': 'private, no-store' },
      }),
    ).toBeDefined();
    expect(approval(testCase, before, { status: 401, upstream: [], headers: {} })).toBeDefined();
  });

  it('only accepts the unavailable error for a gated 501', () => {
    const approval = build('new-gated-write-route');
    expect(
      approval(testCase, before, { status: 501, upstream: [], body: { errorKey: 'other' } }),
    ).toBeUndefined();
    expect(
      approval(testCase, before, {
        status: 501,
        upstream: [],
        body: { errorKey: 'feature.unavailable' },
      }),
    ).toBeDefined();
  });
});

// 社交：关注的歌手、关注的人、粉丝（`concern.RelationList`）和好友（`homepage.Friendship.GetFriendList`），
// 都要登录、只读本人第一页。2026-11 带会话实测（Android）四支都 code 0：RelationList 回
// `{ Total, List, HasMore（布尔）, LastPos, LockFlag, LockMsg, SelfInfo }`，好友回 `{ Friends, HasMore（数字） }`。
// 会员图标、勋章、隐私提示文字不交出；对方锁了隐私时回 locked，和「真的是空」分开。

const person = (n: number, overrides: Record<string, unknown> = {}) => ({
  MID: n % 2 ? `fixtureMid${n}` : '',
  EncUin: n % 2 ? '' : `fixture-enc-${n}`,
  Name: `Fixture person ${n}`,
  Desc: `Fixture desc ${n}`,
  AvatarUrl: `https://y.gtimg.cn/fixture-${n}.jpg`,
  VipIconUrl: 'https://y.gtimg.cn/fixture-private-vip.png',
  FanNum: 100 + n,
  IsFollow: n % 2 === 1,
  Medal: { Medal: { Title: 'fixture-private-medal' } },
  ...overrides,
});
const answered = (n: number) => ({
  mid: n % 2 ? `fixtureMid${n}` : '',
  encUin: n % 2 ? '' : `fixture-enc-${n}`,
  name: `Fixture person ${n}`,
  desc: `Fixture desc ${n}`,
  avatar: `https://y.gtimg.cn/fixture-${n}.jpg`,
  fanCount: 100 + n,
  followed: n % 2 === 1,
});
const relation = (people: unknown[], overrides: Record<string, unknown> = {}) => ({
  Msg: '',
  Total: people.length,
  FromLimit: 0,
  List: people,
  HasMore: false,
  LastPos: '',
  LockFlag: 0,
  LockMsg: 'fixture-private-lock-msg',
  SelfInfo: { Name: 'fixture-private-self' },
  ...overrides,
});
const friend = (n: number, overrides: Record<string, unknown> = {}) => ({
  EncryptUin: `fixture-enc-friend-${n}`,
  UserName: `Fixture friend ${n}`,
  IsFollow: n % 2,
  AvatarUrl: `https://thirdqq.qlogo.cn/fixture-${n}.png`,
  VipInfo: { IsVip: 1, IsGreenVip: 1, VipLevel: 6, GreenIconUrl: 'fixture-private-green' },
  ...overrides,
});
const defaults = (): Record<string, Reply> => ({
  GetFollowSingerList: { data: relation([person(1), person(3)]) },
  GetFollowUserList: { data: relation([person(2)]) },
  GetFansList: { data: relation([person(2), person(4)], { Total: 9, HasMore: true }) },
  GetFriendList: { data: { Friends: [friend(1), friend(2)], HasMore: 0 } },
});

const ROUTES = [
  ['/user/following/singers', 'GetFollowSingerList', { MID: '' }],
  ['/user/following/users', 'GetFollowUserList', { MID: '' }],
  ['/user/followers', 'GetFansList', {}],
] as const;

describe.each(['node', 'serverless'] as Runtime[])('social routes: %s', (runtime) => {
  const ctx = setupSessionRoute(runtime, defaults);

  it.each(ROUTES)('limits oversized %s and marks more', async (path, method) => {
    ctx.replies[method] = { data: relation(Array.from({ length: 21 }, (_, i) => person(i + 1))) };
    const result = await ctx.call(path, { token: ctx.token });
    expect(result.status).toBe(200);
    expect(result.body.items.map((item: { name: string }) => item.name)).toEqual(
      Array.from({ length: 20 }, (_, i) => `Fixture person ${i + 1}`),
    );
    expect(result.body.more).toBe(true);
  });

  it('limits oversized friends and marks more', async () => {
    ctx.replies.GetFriendList = {
      data: { Friends: Array.from({ length: 51 }, (_, i) => friend(i + 1)), HasMore: 0 },
    };
    const result = await ctx.call('/user/friends', { token: ctx.token });
    expect(result.status).toBe(200);
    expect(result.body.items.map((item: { name: string }) => item.name)).toEqual(
      Array.from({ length: 50 }, (_, i) => `Fixture friend ${i + 1}`),
    );
    expect(result.body.more).toBe(true);
  });

  describe.each(ROUTES)('%s', (path, method) => {
    sharedSessionReadCases(runtime, ctx, path, method);
  });
  describe('/user/friends', () => {
    sharedSessionReadCases(runtime, ctx, '/user/friends', 'GetFriendList');
  });

  it.each(
    ROUTES,
  )('%s reads the first page of the own account with %s', async (path, method, extra) => {
    const result = await ctx.call(path, { token: ctx.token });

    expect(result.status).toBe(200);
    expect(result.headers['cache-control']).toBe('private, no-store');
    expect(ctx.recorded[0].rpcs).toEqual([
      {
        module: 'music.concern.RelationList',
        method,
        param: {
          HostUin: CONTRACT_CREDENTIAL.encryptUin,
          ...extra,
          From: 0,
          Size: 20,
          FromPos: '',
        },
      },
    ]);
    expect(ctx.recorded[0].comm).toMatchObject({ ct: 11, authst: CONTRACT_CREDENTIAL.musickey });
    expect(JSON.stringify(result.body)).not.toContain('fixture-private');
  });

  it('keeps the public profile of each followed singer', async () => {
    const result = await ctx.call('/user/following/singers', { token: ctx.token });

    expect(result.body).toEqual({
      code: 200,
      items: [answered(1), answered(3)],
      total: 2,
      more: false,
    });
  });

  it('passes the total and the more flag through for followers', async () => {
    const result = await ctx.call('/user/followers', { token: ctx.token });

    expect(result.body).toEqual({
      code: 200,
      items: [answered(2), answered(4)],
      total: 9,
      more: true,
    });
  });

  it('a privacy lock is locked:true, not an empty list', async () => {
    ctx.replies.GetFollowUserList = { data: relation([], { LockFlag: 1, Total: 0 }) };

    const result = await ctx.call('/user/following/users', { token: ctx.token });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ code: 200, items: [], total: 0, more: false, locked: true });
    expect(JSON.stringify(result.body)).not.toContain('fixture-private');
  });

  it('skips people without a name or any id and leaves out numbers it cannot read', async () => {
    ctx.replies.GetFollowSingerList = {
      data: relation(
        [
          null,
          person(5, { Name: '' }),
          person(7, { MID: '', EncUin: '' }),
          person(9, { FanNum: -1, IsFollow: 'x' }),
        ],
        { Total: '4' },
      ),
    };

    const result = await ctx.call('/user/following/singers', { token: ctx.token });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      code: 200,
      items: [
        {
          mid: 'fixtureMid9',
          encUin: '',
          name: 'Fixture person 9',
          desc: 'Fixture desc 9',
          avatar: 'https://y.gtimg.cn/fixture-9.jpg',
        },
      ],
      total: null,
      more: false,
    });
  });

  it.each([
    ['an empty list', relation([])],
    ['null', relation([], { List: null })],
  ])('nobody followed (%s) is a normal empty list', async (_label, data) => {
    ctx.replies.GetFollowSingerList = { data };

    const result = await ctx.call('/user/following/singers', { token: ctx.token });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ code: 200, items: [], total: 0, more: false });
  });

  it.each([
    ['a non-list', relation([], { List: {} })],
    ['nothing readable', relation([person(11, { Name: null })])],
    ['a non-object payload', 'x'],
  ])('answers 502 for %s instead of an empty list', async (_label, data) => {
    ctx.replies.GetFansList = { data };

    const result = await ctx.call('/user/followers', { token: ctx.token });

    expect(result.status).toBe(502);
    expect(result.body.errorKey).toBe('upstream.invalid-response');
  });

  it('reads the first page of friends without their membership details', async () => {
    const result = await ctx.call('/user/friends', { token: ctx.token });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      code: 200,
      items: [
        {
          encUin: 'fixture-enc-friend-1',
          name: 'Fixture friend 1',
          avatar: 'https://thirdqq.qlogo.cn/fixture-1.png',
          followed: true,
        },
        {
          encUin: 'fixture-enc-friend-2',
          name: 'Fixture friend 2',
          avatar: 'https://thirdqq.qlogo.cn/fixture-2.png',
          followed: false,
        },
      ],
      more: false,
    });
    expect(ctx.recorded[0].rpcs).toEqual([
      {
        module: 'music.homepage.Friendship',
        method: 'GetFriendList',
        param: { Page: 0, PageSize: 50 },
      },
    ]);
    expect(JSON.stringify(result.body)).not.toContain('fixture-private');
  });

  it('friends: HasMore 1 is more:true; an empty list is normal; a non-list is 502', async () => {
    ctx.replies.GetFriendList = { data: { Friends: [friend(3)], HasMore: 1 } };
    expect((await ctx.call('/user/friends', { token: ctx.token })).body.more).toBe(true);

    ctx.replies.GetFriendList = { data: { Friends: null, HasMore: 0 } };
    expect((await ctx.call('/user/friends', { token: ctx.token })).body).toEqual({
      code: 200,
      items: [],
      more: false,
    });

    ctx.replies.GetFriendList = { data: { Friends: {}, HasMore: 0 } };
    expect((await ctx.call('/user/friends', { token: ctx.token })).status).toBe(502);
  });
});
