import './helpers/sessionRoutes';
import { CATALOG_RUNTIMES, callRoute } from './helpers/catalogRoutes';
import { useSessionUpstream } from './helpers/sessionRoutes';

// 分类屏蔽只读契约：首屏不是完整清单，单曲可选风格不等于风格黑名单。
const ENTRY = { ID: '70001', IdType: 7, Name: 'Fixture entry', Img: '', Time: 123 };
const LIST = {
  Retcode: 0,
  Msg: 'fixture-private-message',
  Token: 'fixture-private-token',
  Page: 1,
  Songs: [ENTRY],
  Singers: [ENTRY],
  Styles: [ENTRY],
};

describe.each(CATALOG_RUNTIMES)('blacklist reads: %s', (runtime) => {
  const upstream = useSessionUpstream(runtime);
  const call = async (path: string, mode: 'valid' | 'missing' | 'invalid' = 'valid') => {
    const options = await upstream.options(mode);
    await options.beforeEachLeg?.();
    return callRoute(runtime, path, {
      headers: options.token ? { 'X-QQ-Session': options.token } : {},
      env: options.env,
    });
  };
  beforeEach(() => {
    upstream.state.rpcReplies = {
      GetDislikeList: { data: LIST },
      GetDislikeConfigStyles: {
        data: { Styles: [{ ID: '9', IdType: 10, Name: 'Fixture style', Status: 0 }] },
      },
    };
  });

  it.each([
    ['song', 3],
    ['singer', 2],
    ['style', 4],
  ])('reads only the first %s page with Cmd %s', async (type, cmd) => {
    const result = await call(`/user/blacklist?type=${type}`);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      code: 200,
      type,
      items: [{ id: '70001', idType: 7, name: 'Fixture entry', image: '', time: 123 }],
      coverage: 'first-page',
      complete: false,
    });
    expect(upstream.calls.flatMap((c) => c.rpc)).toEqual([
      {
        module: 'music.feedback.FeedbackBlack',
        method: 'GetDislikeList',
        param: { Cmd: cmd, Page: 1, SongLastid: 0, SingersLastid: 0 },
      },
    ]);
    expect(JSON.stringify(result.body)).not.toContain('fixture-private');
  });

  it('keeps an empty first page distinct from a verified complete empty list', async () => {
    upstream.state.rpcReplies = { GetDislikeList: { data: { ...LIST, Songs: [] } } };
    const result = await call('/user/blacklist?type=song');
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ items: [], complete: false, coverage: 'first-page' });
  });

  it.each([
    '',
    '?type=user',
    '?type=song&page=2',
    '?type=song&cursor=unverified',
  ])('does not pretend to support unknown categories or pagination: %s', async (query) => {
    const result = await call(`/user/blacklist${query}`);
    expect(result.status).toBe(400);
    expect(upstream.calls).toHaveLength(0);
  });

  it.each(['missing', 'invalid'] as const)('does not read anonymously: %s', async (mode) => {
    expect((await call('/user/blacklist?type=style', mode)).status).toBe(401);
    expect(upstream.calls).toHaveLength(0);
  });

  it.each([
    { ...LIST, Songs: {} },
    { ...LIST, Songs: [{}] },
    { ...LIST, Retcode: '0' },
    {},
  ])('rejects an unreadable list', async (data) => {
    upstream.state.rpcReplies = { GetDislikeList: { data } };
    const result = await call('/user/blacklist?type=song');
    expect(result.status).toBe(502);
    expect(result.body).toMatchObject({ errorKey: 'upstream.invalid-response' });
  });

  it('checks inner Retcode and does not promote it to credential invalid', async () => {
    upstream.state.rpcReplies = { GetDislikeList: { data: { ...LIST, Retcode: 1000 } } };
    const result = await call('/user/blacklist?type=song');
    expect(result.status).toBe(502);
    expect(result.body).toMatchObject({ errorKey: 'upstream.unknown', upstreamCode: 1000 });
  });

  it('gets style choices only for the requested song without inventing status meaning', async () => {
    const result = await call('/user/blacklist/style-options?songId=90001');
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      code: 200,
      styles: [{ id: '9', idType: 10, name: 'Fixture style', status: 0 }],
    });
    expect(upstream.calls[0].rpc[0].param).toEqual({ Song: 90001 });
  });

  it('permits songs that have no style choices', async () => {
    upstream.state.rpcReplies = { GetDislikeConfigStyles: { data: { Styles: [] } } };
    expect((await call('/user/blacklist/style-options?songId=90001')).body).toEqual({
      code: 200,
      styles: [],
    });
  });

  it.each([
    '',
    '?songId=0',
    '?songId=abc',
    '?songId=9007199254740992',
  ])('rejects invalid song IDs: %s', async (query) => {
    expect((await call(`/user/blacklist/style-options${query}`)).status).toBe(400);
    expect(upstream.calls).toHaveLength(0);
  });

  it('does not retry a failed list read', async () => {
    upstream.state.rpcReplies = { GetDislikeList: { httpStatus: 503 } };
    expect((await call('/user/blacklist?type=song')).status).toBe(502);
    expect(upstream.calls).toHaveLength(1);
  });
});
