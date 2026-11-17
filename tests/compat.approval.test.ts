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
