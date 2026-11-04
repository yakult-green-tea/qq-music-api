// 对一个已编译的包根目录（含 dist/）跑全部比对案例，把结果写成 JSON。
// 由 scripts/compat/check.js 在独立子进程里调用：两个版本各开一个进程，互不共享模块缓存和全局替换。
// 用法：node scripts/compat/runner.js <包根目录> <案例 JSON> <输出 JSON>
'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const [root, casesFile, outputFile] = process.argv.slice(2).map((value) => path.resolve(value));

const FIXED_NOW = 1800000000000;
const SECRET = 'compat-deployment-secret';
const SESSION_TOKEN = 'c'.repeat(64);
const CREDENTIAL = {
  musicid: '10000',
  str_musicid: '10000',
  musickey: 'fixture-private-music-key',
  encryptUin: 'fixture-private-encrypted-uin',
  loginType: 2,
};
const DEVICE = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../../tests/fixtures/contracts/device-v1.json'), 'utf8'),
).device;

// 时间、随机数固定下来，两个版本送出的上游请求才能逐字比较。
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...values) {
    super(...(values.length ? values : [FIXED_NOW]));
  }
  static now() {
    return FIXED_NOW;
  }
};
let seed = 1;
const reseed = () => {
  seed = 1;
};
Math.random = () => {
  seed = (seed * 16807) % 2147483647;
  return (seed - 1) / 2147483646;
};

// guid、IV 这类加密随机数也要固定；包在载入时就拿走 randomBytes 的引用，所以必须在 require 之前换。
const nextByte = () => Math.floor(Math.random() * 256);
const nodeCrypto = require('node:crypto');
nodeCrypto.randomBytes = (size) => Buffer.from(Array.from({ length: size }, nextByte));
globalThis.crypto.getRandomValues = (array) => {
  const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = nextByte();
  return array;
};
const fakeUuid = () => {
  const hex = Array.from({ length: 16 }, () => nextByte().toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
globalThis.crypto.randomUUID = fakeUuid;
nodeCrypto.randomUUID = fakeUuid;

const realFetch = globalThis.fetch;
let scenario = 'ok';
let upstream = [];

const sortDeep = (value) => {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortDeep(value[key])]),
    );
  return value;
};

const parseJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const SONGS = [
  { mid: 'fixture-song-a', id: 90001, name: 'Fixture song A', title: 'Fixture song A' },
  { mid: 'fixture-song-b', id: 90002, name: 'Fixture song B', title: 'Fixture song B' },
];

// 「正常」情境下认得的几个上游方法给最小的成功数据，其余一律回空对象。
const rpcData = (method, param) => {
  switch (method) {
    case 'GetLoginUserInfo':
      return { info: { nick: 'Fixture user' }, musickey: CREDENTIAL.musickey };
    case 'GetPlaylistByUin':
      return { v_playlist: [{ tid: 70001, dirId: 10, dissname: 'Fixture playlist' }], bFinish: true };
    case 'CgiGetPlaylistFavInfo':
      return { v_list: [], hasmore: 0 };
    case 'CgiGetDiss':
      return { songlist: SONGS, total_song_num: SONGS.length, hasmore: 0 };
    case 'UrlGetVkey':
      return {
        sip: ['https://stream.invalid/'],
        midurlinfo: (param?.songmid ?? []).map((songmid) => ({ songmid, purl: 'fixture.mp3' })),
      };
    case 'get_song_detail_yqq':
      return { track_info: SONGS[0] };
    case 'GetAlbumList':
      return { list: [{ album_mid: 'fixture-album', album_name: 'Fixture album' }] };
    case 'GetAll':
      return { group: [
        { groupId: 0, groupName: 'Fixture zero', toplist: [{ topId: 4, title: 'Fixture zero chart', song: [] }] },
        { groupId: 1, groupName: 'Fixture one', toplist: [{ topId: 5, title: 'Fixture one chart', song: [] }] },
      ] };
    case 'get_singer_detail_info':
      return { songlist: SONGS };
    default:
      return {};
  }
};

const record = async (request) => {
  const url = new URL(request.url);
  const query = [...url.searchParams.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const text = request.method === 'GET' || request.method === 'HEAD' ? '' : await request.text();
  const dataParam = url.searchParams.get('data');
  const json = parseJson(dataParam ?? text);
  upstream.push({
    method: request.method,
    url: `${url.origin}${url.pathname}`,
    query: dataParam ? query.filter(([key]) => key !== 'data') : query,
    body: json === undefined ? text : sortDeep(json),
  });
  return json;
};

const fakeFetch = async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.hostname === '127.0.0.1') return realFetch(input, init);
  const payload = await record(request);
  if (scenario === 'http500') return new Response('fixture-upstream-failure', { status: 500 });
  const isMusicu = url.pathname.endsWith('/musicu.fcg');
  if (isMusicu && payload && typeof payload === 'object') {
    const response = { code: 0 };
    for (const [key, descriptor] of Object.entries(payload)) {
      if (key === 'comm' || !descriptor || typeof descriptor !== 'object') continue;
      response[key] =
        scenario === 'business'
          ? { code: 2000, data: {} }
          : { code: 0, data: rpcData(descriptor.method, descriptor.param) };
    }
    return Response.json(response);
  }
  if (scenario === 'business') return Response.json({ code: -1, subcode: -1 });
  return Response.json({ code: 0, data: {} });
};
globalThis.fetch = fakeFetch;

// 包里的 axios 实例都是 axios.create 出来的；换掉执行器即可，配置照旧。
const axios = require(require.resolve('axios', { paths: [root] }));
const axiosAdapter = async (config) => {
  const url = new URL(String(config.url), config.baseURL);
  for (const [key, value] of Object.entries(config.params ?? {}))
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  const headers = {};
  for (const [key, value] of Object.entries(config.headers ?? {}))
    if (typeof value === 'string') headers[key] = value;
  const response = await fakeFetch(url, {
    method: String(config.method ?? 'GET').toUpperCase(),
    headers,
    body: config.data === undefined ? undefined : String(config.data),
  });
  const text = await response.text();
  const data =
    config.responseType === 'arraybuffer'
      ? new TextEncoder().encode(text).buffer
      : config.responseType === 'text'
        ? text
        : (parseJson(text) ?? text);
  const result = { data, status: response.status, statusText: '', headers: {}, config };
  if (response.status >= 400 && config.validateStatus?.(response.status) !== true)
    throw Object.assign(new Error(`Request failed with status code ${response.status}`), {
      response: result,
      config,
    });
  return result;
};
axios.defaults.adapter = axiosAdapter;
const create = axios.create.bind(axios);
axios.create = (config = {}) => create({ ...config, adapter: axiosAdapter });

const load = (relative) => require(path.join(root, relative));
const appModule = load('dist/src/app.js');
const app = appModule.default ?? appModule;
const { handleRequest } = load('dist/src/serverless/index.js');
const { createSealedSessionResolver } = load('dist/src/serverless/sealedResolver.js');

const nodeSession = { token: SESSION_TOKEN, credential: CREDENTIAL, device: DEVICE, expiresAt: FIXED_NOW + 3600000 };
const restoreNodeSession = () =>
  appModule.configureAuthSessionRepository({
    kind: 'compat',
    load: () => [nodeSession],
    save: () => {},
  });

const normalizeText = (text, tokens) => {
  let result = text;
  for (const token of tokens) if (token) result = result.split(token).join('<session>');
  return result;
};

const KEPT_HEADERS = ['content-type', 'retry-after', 'set-cookie', 'location', 'allow', 'cache-control'];
const pickHeaders = (entries, tokens) => {
  const headers = {};
  for (const [key, value] of entries) {
    const name = key.toLowerCase();
    if (!KEPT_HEADERS.includes(name)) continue;
    const joined = Array.isArray(value) ? value.join('\n') : String(value);
    headers[name] = normalizeText(joined, tokens).replace(/qqmusic_session=[^;]*/g, 'qqmusic_session=<token>');
  }
  return headers;
};

const normalizeBody = (text, tokens) => {
  const normalized = normalizeText(text, tokens);
  const json = parseJson(normalized);
  if (json === undefined) return { text: normalized.length > 400 ? `${normalized.slice(0, 400)}…` : normalized };
  return sortDeep(json);
};

const main = async () => {
  const cases = JSON.parse(fs.readFileSync(casesFile, 'utf8'));
  const sealedToken = await createSealedSessionResolver({ secrets: { current: SECRET } }).issue(nodeSession);
  const tokens = [sealedToken, SESSION_TOKEN];
  const server = http.createServer(app.callback());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const results = {};

  for (const testCase of cases) {
    scenario = testCase.scenario;
    upstream = [];
    reseed();
    const headers = { ...(testCase.body ? { 'content-type': 'application/json' } : {}) };
    let target = testCase.path + (testCase.query ? `?${testCase.query}` : '');
    let response;
    try {
      if (testCase.runtime === 'node') {
        restoreNodeSession();
        if (testCase.session)
          target += `${target.includes('?') ? '&' : '?'}cookie=${encodeURIComponent(`qqmusic_session=${SESSION_TOKEN}`)}`;
        const reply = await realFetch(base + target, {
          method: testCase.method,
          headers,
          body: testCase.body ? JSON.stringify(testCase.body) : undefined,
          redirect: 'manual',
        });
        response = { status: reply.status, headers: [...reply.headers.entries()], text: await reply.text() };
      } else {
        if (testCase.session) headers['x-qq-session'] = sealedToken;
        const reply = await handleRequest(
          new Request(`https://compat.invalid${target}`, {
            method: testCase.method,
            headers,
            body: testCase.body ? JSON.stringify(testCase.body) : undefined,
          }),
          { QQ_SESSION_SECRET: SECRET },
        );
        response = { status: reply.status, headers: [...reply.headers.entries()], text: await reply.text() };
      }
      results[testCase.id] = {
        status: response.status,
        headers: pickHeaders(response.headers, tokens),
        body: normalizeBody(response.text, tokens),
        upstream: JSON.parse(normalizeText(JSON.stringify(upstream), tokens)),
      };
    } catch (error) {
      results[testCase.id] = { thrown: String(error?.message ?? error) };
    }
  }

  server.close();
  fs.writeFileSync(outputFile, JSON.stringify(results));
};

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
