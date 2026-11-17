'use strict';

// 播放条目只多了可选的 source，去掉它之后必须和基准逐字相同。source 一定有 kind、protocol、cdn，
// 另外只可能有 quality、codec（认出文件名时）和 trial（只有 durationMs 一个正整数），值都要在下面的范围里。
const SOURCE_KEYS = ['cdn', 'kind', 'protocol'];
const SOURCE_VALUES = {
  kind: ['full', 'preview', 'unknown'],
  protocol: ['android-vkey', 'preview-rs02', 'web-anonymous-vkey'],
  cdn: ['response-sip', 'probed', 'unverified-default', 'none'],
  quality: ['m4a', '128', '320', 'ape', 'flac', 'preview'],
  codec: ['mp3', 'm4a', 'flac', 'ape'],
};
const validSource = (source) => {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return false;
  const keys = Object.keys(source);
  if (!SOURCE_KEYS.every((key) => keys.includes(key))) return false;
  return keys.every((key) => {
    if (key === 'trial') {
      const trial = source.trial;
      return (
        trial && typeof trial === 'object' && !Array.isArray(trial) &&
        Object.keys(trial).join() === 'durationMs' &&
        Number.isSafeInteger(trial.durationMs) && trial.durationMs > 0 &&
        source.kind === 'preview'
      );
    }
    return SOURCE_VALUES[key]?.includes(source[key]) ?? false;
  });
};
// 只多了登记过的能力旗标：每个都是新加的 true，去掉之后响应和上游请求要和基准逐字相同。
const onlyFlagsAdded = (before, after, flags) => {
  const features = after?.body?.data?.features;
  if (!features || typeof features !== 'object' || !Array.isArray(flags) || !flags.length) return false;
  const stripped = JSON.parse(JSON.stringify(after));
  for (const flag of flags) {
    // 「group.name」表示新加的 true；「group.name=false」表示新加、但还没开放的 false。
    const [path, value = 'true'] = flag.split('=');
    const [group, name] = path.split('.');
    if (before?.body?.data?.features?.[group]?.[name] !== undefined) return false;
    if (stripped.body.data.features[group]?.[name] !== (value === 'true')) return false;
    delete stripped.body.data.features[group][name];
  }
  return JSON.stringify(stripped) === JSON.stringify(before);
};

const onlyPlaySourceAdded = (before, after) => {
  const playUrl = after?.body?.data?.playUrl;
  if (!playUrl || typeof playUrl !== 'object') return false;
  let added = 0;
  const stripped = {};
  for (const [mid, entry] of Object.entries(playUrl)) {
    if (!entry || typeof entry !== 'object') return false;
    const { source, ...rest } = entry;
    if (source !== undefined) {
      if (!validSource(source)) return false;
      added += 1;
    }
    stripped[mid] = rest;
  }
  const restored = { ...after, body: { ...after.body, data: { ...after.body.data, playUrl: stripped } } };
  return added > 0 && JSON.stringify(restored) === JSON.stringify(before);
};
const privateNoStore = (headers) => {
  const value = headers?.['cache-control'];
  if (typeof value !== 'string') return false;
  const directives = value.split(',').map((item) => item.trim().toLowerCase());
  return directives.includes('private') && directives.includes('no-store');
};
const approvalOf = (testCase, before, after, approved, baselineVersion) =>
  approved.find(
    (entry) =>
      (testCase.path === entry.path || testCase.path.startsWith(`${entry.path}/`)) &&
      (!entry.runtime || entry.runtime === testCase.runtime) &&
      (entry.session === undefined || entry.session === testCase.session) &&
      (!entry.difference || (entry.difference === 'play-source-field' && onlyPlaySourceAdded(before, after)) ||
        (entry.difference === 'encrypted-playback-added' &&
          testCase.path === entry.path && testCase.method === 'GET' &&
          before?.status === (testCase.runtime === 'node' ? 404 : 501) &&
          before.upstream.length === 0 &&
          (testCase.session ? [200, 400, 502].includes(after?.status) : after?.status === 401)) ||
        (entry.difference === 'new-session-route' &&
          testCase.path === entry.path && testCase.method === 'GET' &&
          before?.status === (testCase.runtime === 'node' ? 404 : 501) &&
          before.upstream.length === 0 &&
          (testCase.session ? [200, 400, 401, 502].includes(after?.status) :
            after?.status === 401 && after.upstream.length === 0 &&
            privateNoStore(after.headers))) ||
        (entry.difference === 'new-gated-write-route' &&
          testCase.path === entry.path &&
          before?.status === (testCase.runtime === 'node' ? 404 : 501) &&
          before.upstream.length === 0 &&
          [400, 401, 405, 415, 501].includes(after?.status) &&
          (testCase.method !== 'POST' || after.status === 501) &&
          (after.status !== 501 || after.body?.errorKey === 'feature.unavailable') &&
          after.upstream.length === 0) ||
        // 真账号实写验收后开放的写入：旧版不存在；新版每个回应都要 private, no-store。没会话只能是 401 或
        // 415 且一次上游都不打；带会话可以是写入结果（200、400、502），415 不能打上游；别的方法只能是 405。
        (entry.difference === 'new-session-write-route' &&
          testCase.path === entry.path &&
          before?.status === (testCase.runtime === 'node' ? 404 : 501) &&
          before.upstream.length === 0 &&
          privateNoStore(after?.headers) &&
          (testCase.method !== 'POST'
            ? after.status === 405 && after.upstream.length === 0
            : testCase.session
              ? [200, 400, 502].includes(after.status) ||
                (after.status === 415 && after.upstream.length === 0)
              : [401, 415].includes(after.status) && after.upstream.length === 0)) ||
        (entry.difference === 'capability-flags-added' &&
          testCase.path === entry.path && onlyFlagsAdded(before, after, entry.flags)) ||
        (entry.difference === 'toplist-group-zero' &&
        testCase.path === '/recommend/toplists' && testCase.scenario === 'ok' &&
        JSON.stringify(after?.body?.groups?.[0]) === JSON.stringify({ id: 0, name: 'Fixture zero', toplists: [{ id: 4, preview: [], title: 'Fixture zero chart' }] }) &&
        JSON.stringify({ ...after, body: { ...after.body, groups: after.body.groups.slice(1) } }) === JSON.stringify(before))) &&
      // 带 baseline 的登记只对那个基准版本成立，换了基准就不再放行。
      (!entry.baseline || entry.baseline === baselineVersion),
  );

module.exports = approvalOf;
