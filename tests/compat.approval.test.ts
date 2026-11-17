const approvalOf = require('../scripts/compat/approval');

describe('compat approval boundaries', () => {
  const build = (difference: string) => (testCase: unknown, before: unknown, after: unknown) =>
    approvalOf(testCase, before, after, [{ path: '/fixture', difference }], '3.3.7');
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
    expect(approval(testCase, before, { status: 401, upstream: [], headers: {} })).toBeUndefined();
  });

  it.each([
    ['node', 404],
    ['serverless', 501],
  ])('requires exact cache directives on %s', (runtime, status) => {
    const approval = build('new-session-route');
    const request = { ...testCase, runtime };
    const baseline = { status, upstream: [] };
    expect(
      approval(request, baseline, {
        status: 401,
        upstream: [],
        headers: { 'cache-control': 'x-private, x-no-store' },
      }),
    ).toBeUndefined();
    expect(
      approval(request, baseline, {
        status: 401,
        upstream: [],
        headers: { 'cache-control': ' Private , NO-STORE ' },
      }),
    ).toBeDefined();
  });

  it.each([
    ['node', 404],
    ['serverless', 501],
  ])('requires gated POST to return unavailable on %s', (runtime, status) => {
    const approval = build('new-gated-write-route');
    const request = { ...testCase, runtime, method: 'POST' };
    const baseline = { status, upstream: [] };
    for (const code of [400, 401])
      expect(approval(request, baseline, { status: code, upstream: [] })).toBeUndefined();
    expect(
      approval(request, baseline, { status: 501, upstream: [], body: { errorKey: 'other' } }),
    ).toBeUndefined();
    expect(
      approval(request, baseline, {
        status: 501,
        upstream: [],
        body: { errorKey: 'feature.unavailable' },
      }),
    ).toBeDefined();
  });

  it('keeps the gated non-POST status set and requires zero upstream calls', () => {
    const approval = build('new-gated-write-route');
    for (const status of [400, 401, 405, 415]) {
      expect(approval(testCase, before, { status, upstream: [] })).toBeDefined();
      expect(approval(testCase, before, { status, upstream: [{}] })).toBeUndefined();
    }
  });

  describe.each([
    ['node', 404],
    ['serverless', 501],
  ])('opened session write route on %s', (runtime, baselineStatus) => {
    const approval = build('new-session-write-route');
    const baseline = { status: baselineStatus, upstream: [] };
    const headers = { 'cache-control': 'private, no-store' };
    const post = (session: boolean) => ({ ...testCase, runtime, method: 'POST', session });

    it('accepts an anonymous 401 or 415 only without upstream calls and with no-store', () => {
      for (const status of [401, 415]) {
        expect(approval(post(false), baseline, { status, upstream: [], headers })).toBeDefined();
        expect(
          approval(post(false), baseline, { status, upstream: [{}], headers }),
        ).toBeUndefined();
        expect(
          approval(post(false), baseline, { status, upstream: [], headers: {} }),
        ).toBeUndefined();
      }
      for (const status of [200, 400, 501, 502])
        expect(approval(post(false), baseline, { status, upstream: [], headers })).toBeUndefined();
    });

    it('accepts a session write result but never the closed 501', () => {
      for (const status of [200, 400, 502])
        expect(approval(post(true), baseline, { status, upstream: [{}], headers })).toBeDefined();
      expect(approval(post(true), baseline, { status: 415, upstream: [], headers })).toBeDefined();
      expect(
        approval(post(true), baseline, { status: 415, upstream: [{}], headers }),
      ).toBeUndefined();
      for (const status of [401, 501])
        expect(approval(post(true), baseline, { status, upstream: [], headers })).toBeUndefined();
      expect(
        approval(post(true), baseline, { status: 200, upstream: [{}], headers: {} }),
      ).toBeUndefined();
    });

    it('accepts only 405 without upstream calls for other methods', () => {
      const get = { ...testCase, runtime, method: 'GET', session: true };
      expect(approval(get, baseline, { status: 405, upstream: [], headers })).toBeDefined();
      expect(approval(get, baseline, { status: 405, upstream: [{}], headers })).toBeUndefined();
      expect(approval(get, baseline, { status: 200, upstream: [], headers })).toBeUndefined();
    });

    it('requires the route to be absent in the baseline', () => {
      expect(
        approval(
          post(true),
          { status: 200, upstream: [] },
          { status: 200, upstream: [{}], headers },
        ),
      ).toBeUndefined();
    });
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
