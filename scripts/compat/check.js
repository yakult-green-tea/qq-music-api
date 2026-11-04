// 行为比对：同一份离线假上游，分别跑「已发布的某个版本」和「当前工作树的 dist」，
// 逐条比较全部路由在 Node 与 Serverless 上的状态码、关键响应头、响应体，以及送给上游的请求。
// 重构时用它确认对外行为没变；预期中的差异（例如退役的路由）登记在 approved.json，
// 每条可以限定 runtime、限定只放行带或不带会话的案例（session），也可以用 baseline 限定只对某个基准版本成立。
//
// 用法：npm run build:js && npm run compat:check -- [--baseline 3.3.3] [--only /getSongInfo]
// 不连真实 QQ；只有第一次取某个基准版本时会向 npm 下载包。
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repo = path.resolve(__dirname, '../..');
const pkg = require(path.join(repo, 'package.json'));
const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};

const npm = (npmArgs, cwd) =>
  process.env.npm_execpath
    ? spawnSync(process.execPath, [process.env.npm_execpath, ...npmArgs], { cwd, encoding: 'utf8' })
    : spawnSync('npm', npmArgs, { cwd, encoding: 'utf8', shell: process.platform === 'win32' });

const fail = (message) => {
  console.error(message);
  process.exit(1);
};

const baselineVersion = option('--baseline') ?? npm(['view', pkg.name, 'version'], repo).stdout.trim();
if (!/^\d+\.\d+\.\d+/.test(baselineVersion)) fail('取不到基准版本号，请用 --baseline 指定');

// 基准包解到仓库里的 .compat/（不进 git），这样它 require 的 axios、koa 等会用到仓库的 node_modules。
const compatDir = path.join(repo, '.compat');
const baselineRoot = path.join(compatDir, baselineVersion, 'package');
if (!fs.existsSync(path.join(baselineRoot, 'dist/src/app.js'))) {
  const target = path.join(compatDir, baselineVersion);
  fs.mkdirSync(target, { recursive: true });
  // 在目标目录里打包，避免路径里的空格经过 shell 被拆开。
  const packed = npm(['pack', `${pkg.name}@${baselineVersion}`], target);
  if (packed.status !== 0) fail(`下载基准版本失败：\n${packed.stderr}`);
  const tarball = fs.readdirSync(target).find((name) => name.endsWith('.tgz'));
  const extracted = spawnSync('tar', ['-xzf', tarball], { cwd: target, encoding: 'utf8' });
  if (extracted.status !== 0) fail(`解压基准版本失败：\n${extracted.stderr}`);
}
// 仓库拿掉的依赖（例如 3.3.5 移除的 moment、colors）基准版本还要用：只把仓库里找不到的那几个
// 装到 .compat/<版本>/node_modules，基准包往上找得到，仓库自己的依赖不动。
const baselineDeps = require(path.join(baselineRoot, 'package.json')).dependencies ?? {};
const missingDeps = Object.entries(baselineDeps).filter(([name]) => {
  try {
    require.resolve(`${name}/package.json`, { paths: [baselineRoot] });
    return false;
  } catch {
    return true;
  }
});
if (missingDeps.length) {
  const target = path.join(compatDir, baselineVersion);
  fs.writeFileSync(
    path.join(target, 'package.json'),
    `${JSON.stringify({ private: true, dependencies: Object.fromEntries(missingDeps) }, null, 2)}\n`,
  );
  const installed = npm(
    ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock'],
    target,
  );
  if (installed.status !== 0) fail(`安装基准版本缺的依赖失败：\n${installed.stderr}`);
}
if (!fs.existsSync(path.join(repo, 'dist/src/app.js'))) fail('当前工作树还没有 dist，先跑 npm run build:js');

// 路由清单与参数取自两个版本各自的 API Explorer 数据，取并集。
const endpointsOf = (root) =>
  require(path.join(root, 'dist/src/config/apiExplorer.js')).apiExplorerMetadata.endpoints;
const endpoints = new Map();
for (const endpoint of [...endpointsOf(baselineRoot), ...endpointsOf(repo)])
  endpoints.set(`${endpoint.method} ${endpoint.routePath}`, endpoint);

// 每个参数名一个固定的示例值；没列到的用 Explorer 的默认值，再没有就用 fixture。
const SAMPLES = {
  id: '90001', ids: '70001,70002', tid: '70001', dirid: '10', uid: '10000', songmid: 'fixture-song-a',
  songid: '90001', disstid: '70001', albummid: 'fixture-album', singermid: 'fixture-singer',
  mid: 'fixture-song-a', vid: 'fixturevideo', keyword: 'fixture', key: 'fixture', page: '2',
  limit: '5', offset: '3', area: '1', area_id: '15', version_id: '7', topId: '26',
  categoryId: '10000000', sortId: '5', type: 'song', channel: 'wechat', period: '2026-10',
  pagesize: '5', pagenum: '1', cmd: '8', reqtype: '2', biztype: '1', rootcommentid: 'fixture-comment',
  cid: '205360772', order: 'time', sex: '-100', genre: '-100', index: '-100', isFormat: 'true',
  trans: '1', favoriteOffset: '0', playCount: '1', version: '1', quality: 'best', preview: '1',
};
const sampleOf = (field) => SAMPLES[field.key] ?? String(field.defaultValue ?? 'fixture');

const only = option('--only');
// 扫码登录要开 MQTT 长连接或依赖二维码状态，由 tests/folia.http-contracts 等测试覆盖，这里不跑。
const skipped = (endpoint) => endpoint.path.startsWith('/login/qr/');
// 会改会话状态的放到最后。
const last = (endpoint) => (['/logout', '/login/refresh'].includes(endpoint.path) ? 1 : 0);

const cases = [];
const ordered = [...endpoints.values()]
  .filter((endpoint) => !skipped(endpoint) && (!only || endpoint.path === only))
  .sort((a, b) => last(a) - last(b));
for (const endpoint of ordered) {
  const fields = endpoint.queryParams ?? [];
  const sampleQuery = new URLSearchParams(fields.map((field) => [field.key, sampleOf(field)]));
  const duplicated = new URLSearchParams(sampleQuery);
  if (fields[0]) duplicated.append(fields[0].key, 'fixture-duplicate');
  const variants = [
    { name: 'empty', query: '', body: undefined },
    { name: 'sample', query: sampleQuery.toString(), body: endpoint.bodyExample },
    { name: 'duplicate', query: duplicated.toString(), body: endpoint.bodyExample },
  ];
  const pathParams = endpoint.pathParams ?? [];
  for (const runtime of ['node', 'serverless']) {
    const paths = [endpoint.path];
    if (runtime === 'node' && pathParams.length)
      paths.push(`${endpoint.path}/${pathParams.map((field) => encodeURIComponent(sampleOf(field))).join('/')}`);
    for (const target of paths)
      for (const session of [false, true]) {
        for (const variant of variants)
          cases.push({ ...variant, runtime, method: endpoint.method, scenario: 'ok', variant: variant.name, session, path: target });
        for (const scenario of ['business', 'http500'])
          cases.push({ ...variants[1], runtime, method: endpoint.method, scenario, variant: 'sample', session, path: target });
      }
  }
}
for (const [index, testCase] of cases.entries()) testCase.id = `${index}`;

fs.mkdirSync(compatDir, { recursive: true });
const casesFile = path.join(compatDir, 'cases.json');
fs.writeFileSync(casesFile, JSON.stringify(cases));

const run = (label, root) => {
  const output = path.join(compatDir, `result-${label}.json`);
  const child = spawnSync(process.execPath, [path.join(__dirname, 'runner.js'), root, casesFile, output], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'silent', QQ_AUTH_STATE_PATH: 'memory', QQ_DISABLE_UPDATE_CHECK: 'true' },
    maxBuffer: 64 * 1024 * 1024,
  });
  if (child.status !== 0) fail(`${label} 跑失败：\n${child.stderr}`);
  return JSON.parse(fs.readFileSync(output, 'utf8'));
};

const started = Date.now();
const baseline = run(`v${baselineVersion}`, baselineRoot);
const current = run('current', repo);

const approved = JSON.parse(fs.readFileSync(path.join(__dirname, 'approved.json'), 'utf8'));
const approvalOf = (testCase, before, after) =>
  approved.find(
    (entry) =>
      (testCase.path === entry.path || testCase.path.startsWith(`${entry.path}/`)) &&
      (!entry.runtime || entry.runtime === testCase.runtime) &&
      (entry.session === undefined || entry.session === testCase.session) &&
      (!entry.difference || (entry.difference === 'toplist-group-zero' &&
        testCase.path === '/recommend/toplists' && testCase.scenario === 'ok' &&
        JSON.stringify(after?.body?.groups?.[0]) === JSON.stringify({ id: 0, name: 'Fixture zero', toplists: [{ id: 4, preview: [], title: 'Fixture zero chart' }] }) &&
        JSON.stringify({ ...after, body: { ...after.body, groups: after.body.groups.slice(1) } }) === JSON.stringify(before))) &&
      // 带 baseline 的登记只对那个基准版本成立，换了基准就不再放行。
      (!entry.baseline || entry.baseline === baselineVersion),
  );

const firstDifference = (a, b, at = '') => {
  if (JSON.stringify(a) === JSON.stringify(b)) return undefined;
  if (a && b && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b)) {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const found = firstDifference(a[key], b[key], `${at}.${key}`);
      if (found) return found;
    }
  }
  return { at: at || '(root)', baseline: JSON.stringify(a)?.slice(0, 200), current: JSON.stringify(b)?.slice(0, 200) };
};

const unexpected = [];
let identical = 0;
let approvedCount = 0;
for (const testCase of cases) {
  const difference = firstDifference(baseline[testCase.id], current[testCase.id]);
  if (!difference) identical += 1;
  else if (approvalOf(testCase, baseline[testCase.id], current[testCase.id])) approvedCount += 1;
  else unexpected.push({ testCase, difference });
}

console.log(
  `基准 ${baselineVersion} 对当前工作树：${cases.length} 个案例，相同 ${identical}，已登记的差异 ${approvedCount}，未预期的差异 ${unexpected.length}（${Math.round((Date.now() - started) / 1000)} 秒）`,
);
for (const { testCase, difference } of unexpected.slice(0, 40))
  console.log(
    `- ${testCase.runtime} ${testCase.method} ${testCase.path}?${testCase.query} [${testCase.scenario}${testCase.session ? '，带会话' : ''}] ${difference.at}\n    基准：${difference.baseline}\n    当前：${difference.current}`,
  );
if (unexpected.length > 40) console.log(`……还有 ${unexpected.length - 40} 个`);
process.exit(unexpected.length ? 1 : 0);
