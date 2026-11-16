import {
  CONTRACT_CREDENTIAL,
  CONTRACT_SECRET,
  type Reply,
  type Runtime,
  setupSessionRoute,
} from './helpers/newSessionRoute';

// 批量「我喜欢」：`POST /user/song/like/batch`，真账号双向实写通过前由 QQ_UNVERIFIED_WRITES_ENABLED 闸住。
// 流程：一次批量核对歌曲身分（CgiGetTrackInfo，每次 20 首）→ 一次批量读红心状态（IsSongFanByMid，实测一次
// 两首都有回答）→ 只把状态不同的歌写一次（PlaylistDetailWrite，dirId 201）→ 读回确认。只收类型 0；
// 写入和读回都不重送。`/user/song/like` 不变。

const songs = (ids: number[]) => ids.map((id) => ({ id, mid: `fixtureMid${id}`, type: 0 }));
const tracksOf = (ids: number[]) => ({
  tracks: ids.map((id) => ({ id, mid: `fixtureMid${id}`, name: `Fixture ${id}` })),
});
const fansOf = (entries: Array<[number, boolean]>) => ({
  m_fan: Object.fromEntries(entries.map(([id, liked]) => [`fixtureMid${id}`, liked])),
});
const WRITE_OK = { retCode: 0, result: { dirId: 201, tid: 7001 } };

describe.each(['node', 'serverless'] as Runtime[])('batch song like route: %s', (runtime) => {
  let fanReplies: Reply[];
  const ctx = setupSessionRoute(runtime, () => ({
    CgiGetTrackInfo: { data: tracksOf([1, 2, 3]) },
    AddSonglist: { data: WRITE_OK },
    DelSonglist: { data: WRITE_OK },
  }));

  const env = (enabled: boolean) => ({
    QQ_SESSION_SECRET: CONTRACT_SECRET,
    ...(enabled ? { QQ_UNVERIFIED_WRITES_ENABLED: '1' } : {}),
  });
  let previous: string | undefined;
  beforeEach(() => {
    previous = process.env.QQ_UNVERIFIED_WRITES_ENABLED;
    process.env.QQ_UNVERIFIED_WRITES_ENABLED = '1';
    fanReplies = [
      {
        data: fansOf([
          [1, false],
          [2, true],
          [3, false],
        ]),
      },
      {
        data: fansOf([
          [1, true],
          [3, true],
        ]),
      },
    ];
    Object.defineProperty(ctx.replies, 'IsSongFanByMid', {
      configurable: true,
      enumerable: true,
      get: () => fanReplies.shift() ?? { data: {} },
    });
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.QQ_UNVERIFIED_WRITES_ENABLED;
    else process.env.QQ_UNVERIFIED_WRITES_ENABLED = previous;
  });
  const post = (body: unknown, options: { token?: string; enabled?: boolean } = {}) => {
    if (options.enabled === false) delete process.env.QQ_UNVERIFIED_WRITES_ENABLED;
    return ctx.call('/user/song/like/batch', {
      method: 'POST',
      token: options.token ?? ctx.token,
      body,
      ...(runtime === 'serverless' ? { env: env(options.enabled !== false) } : {}),
    });
  };
  const methods = () => ctx.recorded.map((item) => item.rpcs.map((rpc) => rpc.method).join('+'));

  it('is closed until the trusted host turns unverified writes on, before looking at the session', async () => {
    const result = await post(
      { songs: songs([1]), liked: true },
      { enabled: false, token: 'c'.repeat(64) },
    );

    expect(result.status).toBe(501);
    expect(result.body.errorKey).toBe('feature.unavailable');
    expect(ctx.recorded).toEqual([]);
  });

  it('answers 401 without a session and writes nothing', async () => {
    const result = await post({ songs: songs([1]), liked: true }, { token: '' });

    expect(result.status).toBe(401);
    expect(result.headers['cache-control']).toBe('private, no-store');
    expect(ctx.recorded).toEqual([]);
  });

  it.each([
    ['a body that is not an object', []],
    ['an empty list', { songs: [], liked: true }],
    ['101 songs', { songs: songs(Array.from({ length: 101 }, (_, i) => i + 1)), liked: true }],
    ['a song of another type', { songs: [{ id: 1, mid: 'fixtureMid1', type: 1 }], liked: true }],
    ['a string id', { songs: [{ id: '1', mid: 'fixtureMid1', type: 0 }], liked: true }],
    ['a bad mid', { songs: [{ id: 1, mid: 'bad mid', type: 0 }], liked: true }],
    ['a repeated song', { songs: songs([1, 1]), liked: true }],
    ['an extra field', { songs: songs([1]), liked: true, dirId: 201 }],
    ['a non-boolean liked', { songs: songs([1]), liked: 1 }],
  ])('%s answers 400 and writes nothing', async (_label, body) => {
    const result = await post(body);

    expect(result.status).toBe(400);
    expect(result.body.errorKey).toBe('input.invalid');
    expect(methods()).not.toContain('AddSonglist');
    expect(methods()).not.toContain('DelSonglist');
  });

  it('checks identity and state in batches, writes only the songs that differ once, then reads back', async () => {
    const result = await post({ songs: songs([1, 2, 3]), liked: true });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      code: 200,
      liked: true,
      results: [
        { id: 1, status: 'changed' },
        { id: 2, status: 'unchanged' },
        { id: 3, status: 'changed' },
      ],
      writeAttempted: true,
      accepted: true,
      verified: true,
    });
    expect(methods()).toEqual([
      'CgiGetTrackInfo',
      'IsSongFanByMid',
      'AddSonglist',
      'IsSongFanByMid',
    ]);
    const rpcs = ctx.recorded.map((item) => item.rpcs[0]);
    expect(rpcs[0]).toEqual({
      module: 'music.trackInfo.UniformRuleCtrl',
      method: 'CgiGetTrackInfo',
      param: { ids: [1, 2, 3], types: [1, 1, 1] },
    });
    expect(rpcs[1].param).toEqual({ v_songMid: ['fixtureMid1', 'fixtureMid2', 'fixtureMid3'] });
    expect(rpcs[2]).toEqual({
      module: 'music.musicasset.PlaylistDetailWrite',
      method: 'AddSonglist',
      param: {
        dirId: 201,
        v_songInfo: [
          { songId: 1, songType: 0 },
          { songId: 3, songType: 0 },
        ],
      },
    });
    expect(rpcs[3].param).toEqual({ v_songMid: ['fixtureMid1', 'fixtureMid3'] });
    expect(ctx.recorded[2].comm).toMatchObject({ ct: 11, authst: CONTRACT_CREDENTIAL.musickey });
  });

  it('removing uses DelSonglist with the same flow', async () => {
    fanReplies = [{ data: fansOf([[2, true]]) }, { data: fansOf([[2, false]]) }];
    ctx.replies.CgiGetTrackInfo = { data: tracksOf([2]) };

    const result = await post({ songs: songs([2]), liked: false });

    expect(result.body).toMatchObject({
      liked: false,
      results: [{ id: 2, status: 'changed' }],
      verified: true,
    });
    expect(methods()).toEqual([
      'CgiGetTrackInfo',
      'IsSongFanByMid',
      'DelSonglist',
      'IsSongFanByMid',
    ]);
  });

  it('nothing to change writes nothing and is verified', async () => {
    fanReplies = [{ data: fansOf([[2, true]]) }];
    ctx.replies.CgiGetTrackInfo = { data: tracksOf([2]) };

    const result = await post({ songs: songs([2]), liked: true });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      code: 200,
      liked: true,
      results: [{ id: 2, status: 'unchanged' }],
      writeAttempted: false,
      verified: true,
    });
    expect(methods()).toEqual(['CgiGetTrackInfo', 'IsSongFanByMid']);
  });

  it('a song whose id and mid do not match writes nothing', async () => {
    ctx.replies.CgiGetTrackInfo = {
      data: {
        tracks: [
          { id: 1, mid: 'fixtureMid1' },
          { id: 2, mid: 'otherMid' },
          { id: 3, mid: 'fixtureMid3' },
        ],
      },
    };

    const result = await post({ songs: songs([1, 2, 3]), liked: true });

    expect(result.status).toBe(400);
    expect(methods()).toEqual(['CgiGetTrackInfo']);
  });

  it('a song the catalog does not return writes nothing', async () => {
    ctx.replies.CgiGetTrackInfo = { data: tracksOf([1, 3]) };

    const result = await post({ songs: songs([1, 2, 3]), liked: true });

    expect(result.status).toBe(400);
    expect(methods()).toEqual(['CgiGetTrackInfo']);
  });

  it('an unreadable state before writing writes nothing', async () => {
    fanReplies = [{ data: fansOf([[1, false]]) }];

    const result = await post({ songs: songs([1, 2, 3]), liked: true });

    expect(result.status).toBe(502);
    expect(result.body.errorKey).toBe('upstream.invalid-response');
    expect(methods()).toEqual(['CgiGetTrackInfo', 'IsSongFanByMid']);
  });

  it('a read-back that does not match is unconfirmed, not changed', async () => {
    fanReplies = [
      {
        data: fansOf([
          [1, false],
          [2, true],
          [3, false],
        ]),
      },
      {
        data: fansOf([
          [1, true],
          [3, false],
        ]),
      },
    ];

    const result = await post({ songs: songs([1, 2, 3]), liked: true });

    expect(result.status).toBe(502);
    expect(result.body).toMatchObject({
      kind: 'upstream-business',
      errorKey: 'upstream.unknown',
      retryable: false,
      liked: true,
      results: [
        { id: 1, status: 'changed' },
        { id: 2, status: 'unchanged' },
        { id: 3, status: 'unconfirmed' },
      ],
      writeAttempted: true,
      accepted: true,
      verified: false,
      verification: 'unconfirmed',
    });
    expect(methods().filter((m) => m === 'AddSonglist')).toHaveLength(1);
    fanReplies = [{ data: fansOf([[2, true]]) }];
    expect((await post({ songs: songs([2]), liked: true })).status).toBe(200);
  });

  it('a failed read-back after writing says the write was attempted and does not resend it', async () => {
    fanReplies = [
      {
        data: fansOf([
          [1, false],
          [2, true],
          [3, false],
        ]),
      },
      { httpStatus: 503 },
    ];

    const result = await post({ songs: songs([1, 2, 3]), liked: true });

    expect(result.status).toBe(502);
    expect(result.body).toMatchObject({
      writeAttempted: true,
      accepted: true,
      verified: false,
      verification: 'unconfirmed',
      retryable: false,
    });
    expect(methods().filter((m) => m === 'AddSonglist')).toHaveLength(1);
  });

  it.each([
    ['missing song', { data: fansOf([[1, true]]) }],
    ['rejected read-back', { code: 1000 }],
  ])('%s keeps the session and never repeats the write', async (_label, reply) => {
    fanReplies = [
      {
        data: fansOf([
          [1, false],
          [2, true],
          [3, false],
        ]),
      },
      reply,
    ];
    const result = await post({ songs: songs([1, 2, 3]), liked: true });
    expect(result.status).toBe(502);
    expect(result.body).toMatchObject({
      writeAttempted: true,
      accepted: true,
      verified: false,
      verification: 'unconfirmed',
      retryable: false,
    });
    if (_label === 'missing song')
      expect(result.body).toMatchObject({
        kind: 'upstream-business',
        errorKey: 'upstream.unknown',
        liked: true,
        results: [
          { id: 1, status: 'changed' },
          { id: 2, status: 'unchanged' },
          { id: 3, status: 'unconfirmed' },
        ],
      });
    expect(methods().filter((m) => m === 'AddSonglist')).toHaveLength(1);
    fanReplies = [{ data: fansOf([[2, true]]) }];
    expect((await post({ songs: songs([2]), liked: true })).status).toBe(200);
  });

  it('a failed write is sent once, marked as attempted and never retried', async () => {
    ctx.replies.AddSonglist = { httpStatus: 503 };

    const result = await post({ songs: songs([1, 2, 3]), liked: true });

    expect(result.status).toBe(502);
    expect(result.body).toMatchObject({
      writeAttempted: true,
      accepted: false,
      verified: false,
      retryable: false,
    });
    expect(methods().filter((m) => m === 'AddSonglist')).toHaveLength(1);
  });

  it('an unexpected write answer is not treated as accepted', async () => {
    ctx.replies.AddSonglist = { data: { retCode: 1, result: {} } };

    const result = await post({ songs: songs([1, 2, 3]), liked: true });

    expect(result.status).toBe(502);
    expect(result.body).toMatchObject({ writeAttempted: true, accepted: false, verified: false });
    expect(methods()).toEqual(['CgiGetTrackInfo', 'IsSongFanByMid', 'AddSonglist']);
  });

  it('a business rejection while checking identity keeps the session like /user/song/like and writes nothing', async () => {
    ctx.replies.CgiGetTrackInfo = { code: 1000 };

    const result = await post({ songs: songs([1]), liked: true });

    expect(result.status).toBe(502);
    expect(methods()).toEqual(['CgiGetTrackInfo']);
  });

  it('sends more than 20 songs to the catalog in chunks of 20 within one request', async () => {
    const ids = Array.from({ length: 45 }, (_, i) => i + 1);
    ctx.replies.CgiGetTrackInfo = { data: tracksOf(ids) };
    fanReplies = [{ data: fansOf(ids.map((id) => [id, true])) }];

    const result = await post({ songs: songs(ids), liked: true });

    expect(result.status).toBe(200);
    expect(ctx.recorded[0].rpcs.map((rpc) => (rpc.param.ids as number[]).length)).toEqual([
      20, 20, 5,
    ]);
  });
});
