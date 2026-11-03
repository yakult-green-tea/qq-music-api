import './helpers/sessionRoutes';
import { CATALOG_RUNTIMES, callRoute } from './helpers/catalogRoutes';
import { useSessionUpstream } from './helpers/sessionRoutes';

// 音乐偏好写入仍属受控候选：先读现值，只改指定项后整份写一次，再从偏好页读回确认。
const profile = (key: string, score: number) => ({
  ProfileName: `Fixture ${key}`,
  ProfileKey: key,
  CurrentScore: score,
  TargetScore: 0,
  IsChangeProfile: true,
  IsBlack: false,
});
const page = (scores: [string, number][], code: unknown = 0) =>
  `<script>window.__ssrFirstPageData__ = ${JSON.stringify({
    code,
    data: {
      ProfileScore: scores.map(([key, score]) => profile(key, score)),
      Songs: [],
      UpdateTime: 1,
    },
  })}</script>`;
// 用有序数组：整数形状的对象键会被重新排序。
const BEFORE: [string, number][] = [
  ['10008', 50],
  ['10003', 50],
];
const AFTER: [string, number][] = [
  ['10008', 75],
  ['10003', 50],
];
const UPDATE = { profiles: [{ key: '10008', score: 75 }] };
const PATH = '/user/recommendation-preferences/update';

describe.each(CATALOG_RUNTIMES)('recommendation preference writes: %s', (runtime) => {
  const upstream = useSessionUpstream(runtime);
  let previous: string | undefined;
  let pages: { status?: number; body: string }[];
  let ssrReads = 0;
  const call = async (
    body: unknown,
    enabled = true,
    authenticated = true,
    method: 'GET' | 'POST' = 'POST',
  ) => {
    const options = await upstream.options(authenticated ? 'valid' : 'missing');
    await options.beforeEachLeg?.();
    if (enabled) process.env.QQ_UNVERIFIED_WRITES_ENABLED = '1';
    else delete process.env.QQ_UNVERIFIED_WRITES_ENABLED;
    return callRoute(runtime, PATH, {
      method,
      body: method === 'POST' ? body : undefined,
      headers: options.token ? { 'X-QQ-Session': options.token } : {},
      env: { ...options.env, ...(enabled ? { QQ_UNVERIFIED_WRITES_ENABLED: '1' } : {}) },
    });
  };
  const writes = () =>
    upstream.calls.flatMap((c) => c.rpc).filter((c) => c.method === 'SetUserProfile');
  beforeEach(() => {
    previous = process.env.QQ_UNVERIFIED_WRITES_ENABLED;
    pages = [{ body: page(BEFORE) }, { body: page(AFTER) }];
    ssrReads = 0;
    upstream.state.rpcReplies = { SetUserProfile: { data: { Msg: '' } } };
    const base = jest.mocked(fetch).getMockImplementation();
    jest.mocked(fetch).mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      if (new URL(request.url).host === 'i.y.qq.com') {
        const next = pages[Math.min(ssrReads, pages.length - 1)];
        ssrReads += 1;
        return new Response(next.body, { status: next.status ?? 200 });
      }
      return (base as typeof fetch)(input, init);
    });
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.QQ_UNVERIFIED_WRITES_ENABLED;
    else process.env.QQ_UNVERIFIED_WRITES_ENABLED = previous;
  });

  // QQ 与微信账号都实写过、读回一致（D238）：不用实验开关就能写。
  it('writes without the experimental flag', async () => {
    const result = await call(UPDATE, false);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ verified: true });
    expect(writes()).toHaveLength(1);
  });

  it('requires POST and a valid session', async () => {
    expect((await call(UPDATE, true, true, 'GET')).status).toBe(405);
    expect((await call(UPDATE, true, false)).status).toBe(401);
    expect(ssrReads).toBe(0);
    expect(writes()).toEqual([]);
  });

  it('merges the requested score into the full current list, writes once and reads back', async () => {
    const result = await call(UPDATE);
    expect(result.status).toBe(200);
    expect(writes()).toEqual([
      {
        module: 'music.recommend.UserProfileSettingSvr',
        method: 'SetUserProfile',
        param: {
          Profiles: [
            { Score: 75, ProfileKey: '10008', IsAdjust: 0, IsSetBlack: 0 },
            { Score: 50, ProfileKey: '10003', IsAdjust: 0, IsSetBlack: 0 },
          ],
        },
      },
    ]);
    expect(ssrReads).toBe(2);
    expect(result.body).toEqual({
      code: 200,
      scope: 'account',
      accepted: true,
      writeAttempted: true,
      verified: true,
      verification: 'confirmed',
      profiles: [
        { key: '10008', name: 'Fixture 10008', score: 75 },
        { key: '10003', name: 'Fixture 10003', score: 50 },
      ],
    });
  });

  it('reports an unconfirmed readback without claiming success or writing again', async () => {
    pages = [{ body: page(BEFORE) }, { body: page(BEFORE) }];
    const result = await call(UPDATE);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      accepted: true,
      writeAttempted: true,
      verified: false,
      verification: 'unconfirmed',
    });
    expect(writes()).toHaveLength(1);
  });

  it('does not write when the requested scores are already current', async () => {
    const result = await call({ profiles: [{ key: '10008', score: 50 }] });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      writeAttempted: false,
      verified: true,
      verification: 'confirmed',
    });
    expect(ssrReads).toBe(1);
    expect(writes()).toEqual([]);
  });

  it.each([
    ['not an object', []],
    ['unknown field', { ...UPDATE, station: 'personal-fm' }],
    ['missing profiles', {}],
    ['empty profiles', { profiles: [] }],
    [
      'too many profiles',
      { profiles: Array.from({ length: 33 }, (_, i) => ({ key: `${10000 + i}`, score: 50 })) },
    ],
    ['duplicate key', { profiles: [UPDATE.profiles[0], UPDATE.profiles[0]] }],
    ['non-numeric key', { profiles: [{ key: 'abc', score: 50 }] }],
    ['numeric key type', { profiles: [{ key: 10008, score: 50 }] }],
    ['score above 100', { profiles: [{ key: '10008', score: 101 }] }],
    ['negative score', { profiles: [{ key: '10008', score: -1 }] }],
    ['fractional score', { profiles: [{ key: '10008', score: 50.5 }] }],
    ['string score', { profiles: [{ key: '10008', score: '75' }] }],
    ['extra item field', { profiles: [{ key: '10008', score: 75, isAdjust: 1 }] }],
  ])('rejects invalid input without upstream: %s', async (_name, body) => {
    expect((await call(body)).status).toBe(400);
    expect(ssrReads).toBe(0);
    expect(writes()).toEqual([]);
  });

  it('rejects a key that the account page does not offer, without writing', async () => {
    const result = await call({ profiles: [{ key: '19999', score: 75 }] });
    expect(result.status).toBe(400);
    expect(ssrReads).toBe(1);
    expect(writes()).toEqual([]);
  });

  it('does not write when the current values cannot be read', async () => {
    pages = [{ status: 500, body: 'fixture-private-body' }];
    const result = await call(UPDATE);
    expect(result.status).toBe(502);
    expect(result.body).not.toHaveProperty('writeAttempted');
    expect(writes()).toEqual([]);
  });

  it('marks a rejected write as attempted and does not read back or retry', async () => {
    upstream.state.rpcReplies = { SetUserProfile: { code: 1000 } };
    const result = await call(UPDATE);
    expect(result.status).toBe(502);
    expect(result.body).toMatchObject({
      upstreamCode: 1000,
      writeAttempted: true,
      accepted: false,
      verified: false,
      verification: 'unconfirmed',
      retryable: false,
    });
    expect(writes()).toHaveLength(1);
    expect(ssrReads).toBe(1);
  });

  it('marks a transport failure as an unknown attempted write without resending', async () => {
    upstream.state.networkError = new Error('fixture-private-upstream-token');
    const result = await call(UPDATE);
    expect(result.status).toBe(502);
    expect(result.body).toMatchObject({ writeAttempted: true, verified: false, retryable: false });
    expect(writes()).toHaveLength(1);
    expect(JSON.stringify(result.body)).not.toContain('fixture-private');
  });

  it('rejects a malformed write response as unconfirmed', async () => {
    upstream.state.rpcReplies = { SetUserProfile: { data: [] } };
    const result = await call(UPDATE);
    expect(result.status).toBe(502);
    expect(result.body).toMatchObject({ writeAttempted: true, accepted: false, verified: false });
  });

  it('keeps an accepted write unconfirmed when the readback page fails', async () => {
    pages = [{ body: page(BEFORE) }, { body: '<html>login</html>' }];
    const result = await call(UPDATE);
    expect(result.status).toBe(502);
    expect(result.body).toMatchObject({
      writeAttempted: true,
      accepted: true,
      verified: false,
      verification: 'unconfirmed',
    });
    expect(writes()).toHaveLength(1);
  });
});
