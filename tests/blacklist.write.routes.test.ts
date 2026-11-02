import './helpers/sessionRoutes';
import { CATALOG_RUNTIMES, callRoute } from './helpers/catalogRoutes';
import { useSessionUpstream } from './helpers/sessionRoutes';

// 分类写入仍属受控候选；首屏能确认存在，不能证明全表移除，也不虚构 replacement。
const song = { ID: '91001', IdType: 1, Name: 'Fixture song', Img: '', Time: 101 };
const singer = { ID: '92001', IdType: 2, Name: 'Fixture singer', Img: '', Time: 102 };
const style = { ID: '93001', IdType: 7, Name: 'Fixture style', Img: '', Time: 103 };
const list = {
  Retcode: 0,
  Msg: 'fixture-private',
  Token: 'fixture-private',
  Page: 1,
  Songs: [song],
  Singers: [singer],
  Styles: [style],
};
const songBody = { songs: [song.ID] };
const styleBody = { songId: '91001', styles: [{ id: style.ID, idType: style.IdType }] };

describe.each(CATALOG_RUNTIMES)('blacklist writes: %s', (runtime) => {
  const upstream = useSessionUpstream(runtime);
  let previous: string | undefined;
  const call = async (
    action: 'add' | 'remove',
    body: unknown,
    enabled = true,
    authenticated = true,
    method: 'GET' | 'POST' = 'POST',
  ) => {
    const options = await upstream.options(authenticated ? 'valid' : 'missing');
    await options.beforeEachLeg?.();
    if (enabled) process.env.QQ_UNVERIFIED_WRITES_ENABLED = '1';
    else delete process.env.QQ_UNVERIFIED_WRITES_ENABLED;
    return callRoute(runtime, `/user/blacklist/${action}`, {
      method,
      body: method === 'POST' ? body : undefined,
      headers: options.token ? { 'X-QQ-Session': options.token } : {},
      env: { ...options.env, ...(enabled ? { QQ_UNVERIFIED_WRITES_ENABLED: '1' } : {}) },
    });
  };
  const methods = () => upstream.calls.flatMap((c) => c.rpc).map((c) => c.method);
  const replies = () => (upstream.state.rpcReplies ??= {});
  beforeEach(() => {
    previous = process.env.QQ_UNVERIFIED_WRITES_ENABLED;
    upstream.state.rpcReplies = {
      AddDislike: { data: { Retcode: 0, Token: 'fixture-private', Msg: 'fixture-private' } },
      CancelDislike: { data: { Retcode: 0, Token: 'fixture-private' } },
      GetDislikeList: { data: list },
      GetDislikeConfigStyles: { data: { Styles: [{ ...style, Status: 0 }] } },
    };
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.QQ_UNVERIFIED_WRITES_ENABLED;
    else process.env.QQ_UNVERIFIED_WRITES_ENABLED = previous;
  });

  it.each([
    'add',
    'remove',
  ] as const)('keeps %s disabled by default and never trusts a request-body flag', async (action) => {
    expect((await call(action, { ...songBody, enabled: true }, false)).status).toBe(501);
    expect(methods()).toEqual([]);
  });
  it('allows a songs-only dislike without the experimental flag and writes only songs', async () => {
    const result = await call('add', songBody, false);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ accepted: true, verified: true, writeAttempted: true });
    expect(upstream.calls.flatMap((c) => c.rpc).filter((c) => c.method === 'AddDislike')).toEqual([
      {
        module: 'music.feedback.FeedbackBlack',
        method: 'AddDislike',
        param: { Songs: [{ ID: song.ID }] },
      },
    ]);
  });
  it('still checks the session and input for a songs-only dislike without the flag', async () => {
    expect((await call('add', songBody, false, false)).status).toBe(401);
    expect((await call('add', { songs: [] }, false)).status).toBe(400);
    expect((await call('add', songBody, false, true, 'GET')).status).toBe(405);
    expect(methods()).toEqual([]);
  });
  it.each([
    { singers: [singer.ID] },
    styleBody,
    { songs: [song.ID], singers: [singer.ID] },
    { ...styleBody, songs: [song.ID] },
    [song.ID],
  ])('keeps singer, style and mixed dislikes behind the flag before the session check: %j', async (body) => {
    expect((await call('add', body, false)).status).toBe(501);
    expect((await call('add', body, false, false)).status).toBe(501);
    expect(methods()).toEqual([]);
  });
  it.each(['add', 'remove'] as const)('%s requires POST and a valid session', async (action) => {
    expect((await call(action, songBody, true, true, 'GET')).status).toBe(405);
    expect((await call(action, songBody, true, false)).status).toBe(401);
    expect(methods()).toEqual([]);
  });

  it.each([
    [{ songs: [song.ID] }, ['song']],
    [{ singers: [singer.ID] }, ['singer']],
    [styleBody, ['style']],
    [{ songs: [song.ID], singers: [singer.ID] }, ['song', 'singer']],
    [{ ...styleBody, songs: [song.ID] }, ['song', 'style']],
    [{ ...styleBody, singers: [singer.ID] }, ['singer', 'style']],
    [{ ...styleBody, songs: [song.ID], singers: [singer.ID] }, ['song', 'singer', 'style']],
  ])('writes only selected categories once and checks each target: %j', async (body, types) => {
    const result = await call('add', body);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      accepted: true,
      verified: true,
      verification: 'confirmed',
      writeAttempted: true,
      coverage: 'first-page',
      complete: false,
    });
    const rpc = upstream.calls.flatMap((c) => c.rpc);
    expect(rpc.filter((r) => r.method === 'AddDislike')).toHaveLength(1);
    const param: Record<string, unknown> = {};
    if (types.includes('song')) param.Songs = [{ ID: song.ID }];
    if (types.includes('singer')) param.Singers = [{ ID: singer.ID }];
    if (types.includes('style'))
      param.Styles = [{ ID: style.ID, IdType: style.IdType, Name: style.Name, Img: '' }];
    expect(rpc.find((r) => r.method === 'AddDislike')?.param).toEqual(param);
    expect(rpc.filter((r) => r.method === 'GetDislikeList').map((r) => r.param.Cmd)).toEqual(
      types.map((t) => ({ song: 3, singer: 2, style: 4 })[t as 'song' | 'singer' | 'style']),
    );
    expect(result.body).not.toHaveProperty('replacement');
    expect(JSON.stringify(result.body)).not.toContain('fixture-private');
  });

  it('preserves multiple singers and composite style keys, even when style IDs match', async () => {
    const singer2 = { ...singer, ID: '92002' },
      style2 = { ...style, IdType: 10 };
    replies().GetDislikeList = {
      data: { ...list, Singers: [singer, singer2], Styles: [style, style2] },
    };
    replies().GetDislikeConfigStyles = {
      data: {
        Styles: [
          { ...style, Status: 0 },
          { ...style2, Status: 0 },
        ],
      },
    };
    const result = await call('add', {
      songs: [song.ID],
      singers: [singer.ID, singer2.ID],
      songId: song.ID,
      styles: [
        { id: style.ID, idType: 7 },
        { id: style.ID, idType: 10 },
      ],
    });
    expect(result.body).toMatchObject({ verified: true });
    const write = upstream.calls.flatMap((c) => c.rpc).find((c) => c.method === 'AddDislike');
    expect(write?.param.Singers).toEqual([{ ID: singer.ID }, { ID: singer2.ID }]);
    expect(write?.param.Styles).toEqual([
      { ID: style.ID, IdType: 7, Name: style.Name, Img: '' },
      { ID: style.ID, IdType: 10, Name: style.Name, Img: '' },
    ]);
  });

  it.each([
    null,
    {},
    [],
    { songs: [] },
    { songs: [''] },
    { songs: [123] },
    { songs: ['bad-mid'] },
    { songs: [song.ID, song.ID] },
    { songs: Array.from({ length: 21 }, (_, i) => String(i + 1)) },
    {
      songs: Array.from({ length: 20 }, (_, i) => String(i + 1)),
      singers: Array.from({ length: 20 }, (_, i) => String(i + 1)),
    },
    { songs: [song.ID], OnlyAdd: 1 },
    { songs: [song.ID], songId: song.ID },
    { styles: [{ id: style.ID, idType: 7 }] },
    { ...styleBody, songId: '9007199254740992' },
    { songId: song.ID, styles: [{ id: style.ID, idType: '7' }] },
    { songId: song.ID, styles: [{ id: style.ID, idType: 7, name: 'caller-name' }] },
    {
      songId: song.ID,
      styles: [
        { id: style.ID, idType: 7 },
        { id: style.ID, idType: 7 },
      ],
    },
  ])('rejects invalid input before any upstream request: %j', async (body) => {
    expect((await call('add', body)).status).toBe(400);
    expect(methods()).toEqual([]);
  });
  it('checks that every selected style is actually offered for the source song', async () => {
    replies().GetDislikeConfigStyles = { data: { Styles: [] } };
    expect((await call('add', styleBody)).status).toBe(400);
    expect(methods()).toEqual(['GetDislikeConfigStyles']);
  });
  it('keeps an acknowledged add unconfirmed when its target is absent from the first page', async () => {
    replies().GetDislikeList = { data: { ...list, Songs: [] } };
    const result = await call('add', songBody);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      accepted: true,
      verified: false,
      verification: 'unconfirmed',
      results: [{ type: 'song', id: song.ID, state: 'not-seen-in-first-page' }],
    });
  });
  it.each([
    1000, 5,
  ])('does not turn inner write code %s into success or credential rejection', async (Retcode) => {
    replies().AddDislike = {
      data: { Retcode, Msg: 'fixture-private', Token: 'fixture-private' },
    };
    const result = await call('add', songBody);
    expect(result.status).toBe(502);
    expect(result.body).toMatchObject({
      writeAttempted: true,
      verified: false,
      verification: 'unconfirmed',
      retryable: false,
      upstreamCode: Retcode,
    });
    expect(methods()).toEqual(['AddDislike']);
  });
  it('does not retry a failed write or claim it was never sent', async () => {
    replies().AddDislike = { httpStatus: 503 };
    const result = await call('add', songBody);
    expect(result.status).toBe(502);
    expect(result.body).toMatchObject({ writeAttempted: true, verified: false, retryable: false });
    expect(methods()).toEqual(['AddDislike']);
  });
  it('retains acknowledgement when the confirmation read fails', async () => {
    replies().GetDislikeList = { httpStatus: 503 };
    const result = await call('add', songBody);
    expect(result.status).toBe(502);
    expect(result.body).toMatchObject({
      accepted: true,
      verified: false,
      writeAttempted: true,
      verification: 'unconfirmed',
      retryable: false,
    });
    expect(methods()).toEqual(['AddDislike', 'GetDislikeList']);
  });

  it.each([
    {},
    { Retcode: '0' },
  ])('does not accept a malformed write acknowledgement: %j', async (data) => {
    replies().AddDislike = { data };
    const result = await call('add', songBody);
    expect(result.status).toBe(502);
    expect(result.body).toMatchObject({ accepted: false, verified: false, writeAttempted: true });
    expect(methods()).toEqual(['AddDislike']);
  });
  it('never writes after the style preflight fails', async () => {
    replies().GetDislikeConfigStyles = { httpStatus: 503 };
    const result = await call('add', styleBody);
    expect(result.status).toBe(502);
    expect(result.body).not.toHaveProperty('writeAttempted');
    expect(methods()).toEqual(['GetDislikeConfigStyles']);
  });
  it('reports each category independently without claiming atomic multi-category success', async () => {
    replies().GetDislikeList = { data: { ...list, Singers: [] } };
    const result = await call('add', { songs: [song.ID], singers: [singer.ID] });
    expect(result.body).toMatchObject({
      verified: false,
      results: [
        { type: 'song', state: 'present' },
        { type: 'singer', state: 'not-seen-in-first-page' },
      ],
    });
    expect(methods()).toEqual(['AddDislike', 'GetDislikeList', 'GetDislikeList']);
  });

  it.each([
    ['song', song],
    ['singer', singer],
    ['style', style],
  ] as const)('removes one %s using fresh full read metadata, without claiming complete absence', async (type, item) => {
    upstream.state.rpcReplyQueues = {
      GetDislikeList: [{ data: list }, { data: { ...list, Songs: [], Singers: [], Styles: [] } }],
    };
    const result = await call('remove', { type, id: item.ID, idType: item.IdType });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      accepted: true,
      verified: false,
      verification: 'unconfirmed',
      results: [{ type, id: item.ID, idType: item.IdType, state: 'not-seen-in-first-page' }],
      complete: false,
    });
    expect(result.body).not.toHaveProperty('removed');
    const rpc = upstream.calls.flatMap((c) => c.rpc);
    expect(rpc.map((r) => r.method)).toEqual(['GetDislikeList', 'CancelDislike', 'GetDislikeList']);
    expect(rpc[1].param).toEqual({
      Songs: type === 'song' ? [item] : [],
      Singers: type === 'singer' ? [item] : [],
      Styles: type === 'style' ? [item] : [],
      OnlyAdd: 1,
    });
  });
  it('does not cancel an entry that cannot be found on the current account first page', async () => {
    const result = await call('remove', { type: 'song', id: '99999', idType: 1 });
    expect(result.status).toBe(422);
    expect(methods()).toEqual(['GetDislikeList']);
    expect(result.body).not.toHaveProperty('writeAttempted');
  });
  it('keeps a still-visible cancellation target unconfirmed', async () => {
    const result = await call('remove', { type: 'song', id: song.ID, idType: song.IdType });
    expect(result.body).toMatchObject({
      accepted: true,
      verified: false,
      results: [{ state: 'present' }],
    });
  });
  it('does not retry cancellation when its confirmation read fails', async () => {
    upstream.state.rpcReplyQueues = { GetDislikeList: [{ data: list }, { httpStatus: 503 }] };
    const result = await call('remove', { type: 'song', id: song.ID, idType: song.IdType });
    expect(result.status).toBe(502);
    expect(result.body).toMatchObject({
      accepted: true,
      writeAttempted: true,
      verification: 'unconfirmed',
      retryable: false,
    });
    expect(methods()).toEqual(['GetDislikeList', 'CancelDislike', 'GetDislikeList']);
  });
  it.each([
    {},
    null,
    { type: 'user', id: song.ID, idType: 1 },
    { type: 'song', id: song.ID },
    { type: 'song', id: song.ID, idType: 1, OnlyAdd: 0 },
  ])('rejects unobserved cancel shapes: %j', async (body) => {
    expect((await call('remove', body)).status).toBe(400);
    expect(methods()).toEqual([]);
  });
});
