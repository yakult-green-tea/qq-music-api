import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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
