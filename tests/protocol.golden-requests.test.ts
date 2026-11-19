import './helpers/wireRecorder';
import fs from 'node:fs';
import path from 'node:path';
import { createNativeQr, refreshAndroidSession } from '../src/services/auth/bootstrap';
import {
  exchangeAppCredential,
  exchangeCredential,
  exchangeWechatCredential,
} from '../src/services/auth/credentialWire';
import type { QqCredential } from '../src/services/auth/qrLogin';
import type { AuthHttpClient } from '../src/transport/httpClientTypes';
import type { CatalogRuntimeName } from './helpers/catalogRoutes';
import { CONTRACT_CREDENTIAL } from './helpers/contractUpstream';
import {
  type RecordedCall,
  runOnWire,
  useWireRecorder,
  WIRE_DEVICE,
  type WireScript,
} from './helpers/wireRecorder';

// 把各条路由实际送给上游的请求固定下来：地址、方法、comm、User-Agent、Cookie、文件名和参数。
// 重构客户端身份、设备信息或取链接流程时，这份记录不应该变；确实要变的，先改这里并写明原因。
// 记录按协议分组：带会话的安卓客户端、匿名网页、精简版客户端、旧接口，以及登录时的几种换凭证请求。
// 重新生成：UPDATE_PROTOCOL_GOLDEN=1 npx jest tests/protocol.golden-requests.test.ts --coverage=false

const GOLDEN_FILE = path.join(__dirname, 'fixtures/protocol/golden-requests.json');
const UPDATE = process.env.UPDATE_PROTOCOL_GOLDEN === '1';
const golden: Record<string, unknown> = fs.existsSync(GOLDEN_FILE)
  ? JSON.parse(fs.readFileSync(GOLDEN_FILE, 'utf8'))
  : {};
const produced: Record<string, unknown> = {};

const check = (name: string, actual: unknown) => {
  // 先过一遍 JSON，去掉 undefined，和存盘的内容同一种形状。
  const plain = JSON.parse(JSON.stringify(actual));
  produced[name] = plain;
  if (!UPDATE) expect(plain).toEqual(golden[name]);
};

afterAll(() => {
  if (!UPDATE) return;
  const sorted = Object.fromEntries(
    Object.keys(produced)
      .sort()
      .map((key) => [key, produced[key]]),
  );
  fs.writeFileSync(GOLDEN_FILE, `${JSON.stringify(sorted, null, 2)}\n`);
});

const QQ = CONTRACT_CREDENTIAL as QqCredential;
/** 微信账号的 id 是 19 位，超过 JavaScript 能精确表示的整数。 */
const WECHAT_ID = '1152921504606846999';
const WECHAT: QqCredential = {
  musicid: WECHAT_ID,
  str_musicid: WECHAT_ID,
  musickey: 'fixture-private-wechat-key',
  loginType: 1,
};

const SONG = 'fixtureSongMidA1';
const SONG_B = 'fixtureSongMidB2';
const MEDIA = 'FixtureMedia01';
const granted = (...mids: string[]) => ({
  sip: ['https://stream.invalid/'],
  midurlinfo: mids.map((songmid) => ({ songmid, purl: `${songmid}.audio` })),
});
const refused = (...mids: string[]) => ({
  sip: ['https://stream.invalid/'],
  midurlinfo: mids.map((songmid) => ({ songmid, purl: '', result: 104003, subcode: 1 })),
});
const withoutSip = (...mids: string[]) => ({ ...granted(...mids), sip: [] });

const SEARCH_SCRIPT: WireScript = {
  rpc: {
    DoSearchForQQMusicLite: {
      code: 0,
      body: { item_song: [], item_album: [] },
      meta: { sum: 0, nextpage: -1 },
    },
  },
};

interface GoldenCase {
  name: string;
  path: string;
  credential?: QqCredential;
  script?: WireScript;
  method?: 'GET' | 'POST';
  body?: unknown;
}

const CASES: GoldenCase[] = [
  // 带会话取播放链接：安卓客户端身份
  {
    name: 'play/128',
    path: `/getMusicPlay/${SONG}`,
    credential: QQ,
    script: { rpc: { UrlGetVkey: granted(SONG) } },
  },
  {
    name: 'play/m4a-media-id',
    path: `/getMusicPlay/${SONG}?quality=m4a&mediaId=${MEDIA}`,
    credential: QQ,
    script: { rpc: { UrlGetVkey: granted(SONG) } },
  },
  {
    name: 'play/320',
    path: `/getMusicPlay/${SONG}?quality=320`,
    credential: QQ,
    script: { rpc: { UrlGetVkey: granted(SONG) } },
  },
  {
    name: 'play/flac-media-id',
    path: `/getMusicPlay/${SONG}?quality=flac&mediaId=${MEDIA}`,
    credential: QQ,
    script: { rpc: { UrlGetVkey: granted(SONG) } },
  },
  {
    name: 'play/ape',
    path: `/getMusicPlay/${SONG}?quality=ape`,
    credential: QQ,
    script: {
      rpc: {
        get_song_detail_yqq: { track_info: { file: { size_ape: 1 } } },
        UrlGetVkey: granted(SONG),
      },
    },
  },
  {
    name: 'play/two-songs',
    path: `/getMusicPlay/${SONG},${SONG_B}`,
    credential: QQ,
    script: { rpc: { UrlGetVkey: granted(SONG, SONG_B) } },
  },
  {
    name: 'play/preview',
    path: `/getMusicPlay/${SONG}?preview=1`,
    credential: QQ,
    script: {
      rpc: {
        get_song_detail_yqq: { track_info: { file: { size_try: 1, media_mid: MEDIA } } },
        UrlGetVkey: granted(SONG),
      },
    },
  },
  {
    name: 'play/best-falls-to-320',
    path: `/getMusicPlay/${SONG}?quality=best`,
    credential: QQ,
    script: {
      rpc: {
        get_song_detail_yqq: { track_info: { file: { size_flac: 1, size_320mp3: 1 } } },
        UrlGetVkey: [refused(SONG), granted(SONG)],
      },
    },
  },
  {
    // 安卓身份明确 104003：换官方网页播放器身份、同一个文件名再要一次（320 不走查原因与再取一次）。
    name: 'play/web-session-fallback',
    path: `/getMusicPlay/${SONG}?quality=320&mediaId=${MEDIA}`,
    credential: QQ,
    script: {
      fallback: true,
      rpc: {
        UrlGetVkey: [
          refused(SONG),
          {
            sip: ['https://stream.invalid/'],
            midurlinfo: [
              { songmid: SONG, purl: `M800${SONG}${MEDIA}.mp3?vkey=fixture`, result: 0 },
            ],
          },
        ],
      },
    },
  },
  {
    // 微信账号：网页身份的 uin 用字符串原样送，19 位的 id 不失真。
    name: 'play/web-session-fallback-wechat',
    path: `/getMusicPlay/${SONG}?quality=320&mediaId=${MEDIA}`,
    credential: WECHAT,
    script: { fallback: true, rpc: { UrlGetVkey: [refused(SONG), refused(SONG)] } },
  },
  {
    name: 'play/retry-once',
    path: `/getMusicPlay/${SONG}`,
    credential: QQ,
    script: { rpc: { UrlGetVkey: [refused(SONG), granted(SONG)] } },
  },
  {
    name: 'play/no-sip-preferred-host',
    path: `/getMusicPlay/${SONG}`,
    credential: QQ,
    script: { rpc: { UrlGetVkey: withoutSip(SONG) } },
  },
  {
    name: 'play/no-sip-dispatch',
    path: `/getMusicPlay/${SONG}`,
    credential: QQ,
    script: {
      rpc: {
        UrlGetVkey: withoutSip(SONG),
        GetCdnDispatch: {
          sip: ['http://fixture.stream.qqmusic.qq.com/', 'http://sjy6.stream.qqmusic.qq.com/'],
          refreshTime: 600,
        },
      },
      streams: { 'sjy6.stream.qqmusic.qq.com': 404 },
    },
  },
  {
    name: 'play/no-sip-every-probe-fails',
    path: `/getMusicPlay/${SONG}`,
    credential: QQ,
    script: {
      rpc: {
        UrlGetVkey: withoutSip(SONG),
        GetCdnDispatch: { sip: ['http://fixture.stream.qqmusic.qq.com/'] },
      },
      streams: {
        'sjy6.stream.qqmusic.qq.com': 404,
        'fixture.stream.qqmusic.qq.com': 404,
        'dl.stream.qqmusic.qq.com': 404,
      },
    },
  },
  {
    name: 'play/wechat-account',
    path: `/getMusicPlay/${SONG}`,
    credential: WECHAT,
    script: { rpc: { UrlGetVkey: granted(SONG) } },
  },
  // 不带会话取播放链接：Node 走旧接口，Serverless 直接回 401
  {
    name: 'play/anonymous',
    path: `/getMusicPlay/${SONG}`,
    script: { rpc: { CgiGetVkey: granted(SONG) } },
  },
  {
    name: 'play/anonymous-preview',
    path: `/getMusicPlay/${SONG}?preview=1`,
    script: {
      rpc: {
        get_song_detail_yqq: { track_info: { file: { size_try: 1, media_mid: MEDIA } } },
        CgiGetVkey: granted(SONG),
      },
    },
  },
  // 搜索：带会话用安卓客户端身份，不带会话用精简版客户端身份
  {
    name: 'search/session-song',
    path: '/search?keyword=fixture',
    credential: QQ,
    script: SEARCH_SCRIPT,
  },
  { name: 'search/anonymous-song', path: '/search?keyword=fixture', script: SEARCH_SCRIPT },
  {
    name: 'search/anonymous-album',
    path: '/search?keyword=fixture&type=album',
    script: SEARCH_SCRIPT,
  },
  { name: 'search/users-session', path: '/search/users?keyword=fixture', credential: QQ },
  // 歌词：旧接口，翻译是空的时再用精简版客户端身份补一次
  {
    name: 'lyric/with-translation',
    path: `/getLyric?songmid=${SONG}&trans=1`,
    script: { cgi: { code: 0, lyric: '', trans: '' } },
  },
  // 匿名网页身份
  { name: 'web/song-info', path: `/getSongInfo/${SONG}` },
  { name: 'web/singer-hotsong', path: '/getSingerHotsong?singermid=fixtureSinger01' },
  { name: 'web/song-versions', path: '/song/versions?id=90001' },
  { name: 'web/song-fav-count', path: '/song/fav-count?ids=90001' },
  { name: 'web/radio-categories', path: '/radio/categories' },
  { name: 'web/recommend-playlists', path: '/recommend/playlists' },
  { name: 'web/comment-list', path: '/comment/list?id=90001' },
  { name: 'web/mv-url', path: '/mv/url?vid=fixturevideo' },
  // 带会话的读取：安卓客户端身份，以及带账号 Cookie 的旧接口和偏好页面
  { name: 'session/recommend-playlists', path: '/recommend/playlists', credential: QQ },
  { name: 'session/user-detail', path: '/user/detail', credential: QQ },
  { name: 'session/user-playlist', path: '/user/playlist', credential: QQ },
  { name: 'session/user-albums', path: '/user/albums', credential: QQ },
  { name: 'session/guess-you-like', path: '/user/guess-you-like', credential: QQ },
  { name: 'session/daily-songs', path: '/user/daily-songs', credential: QQ },
  { name: 'session/mv-url', path: '/mv/url?vid=fixturevideo', credential: QQ },
  { name: 'session/preferences-page', path: '/user/recommendation-preferences', credential: QQ },
  { name: 'session/wechat-user-albums', path: '/user/albums', credential: WECHAT },
];

/**
 * Node 匿名取链接用的 guid 是进程启动时随机定的一串数字，每次跑都不一样；确认形状后换成固定的记号。
 */
const withoutProcessGuid = (call: RecordedCall): RecordedCall => {
  const request = (call.json as { req_0?: { method?: string; param?: { guid?: unknown } } })?.req_0;
  if (request?.method !== 'CgiGetVkey' || !request.param) return call;
  expect(String(request.param.guid)).toMatch(/^\d{1,10}$/);
  request.param.guid = '<process-guid>';
  return call;
};

describe('送给上游的请求', () => {
  useWireRecorder();

  it.each(CASES)('$name', async ({ name, path: target, credential, script, method, body }) => {
    const runs: Partial<Record<CatalogRuntimeName, { status: number; calls: RecordedCall[] }>> = {};
    for (const runtime of ['node', 'serverless'] as const) {
      const run = await runOnWire(runtime, target, script, credential, { method, body });
      runs[runtime] = { status: run.status, calls: run.calls.map(withoutProcessGuid) };
    }
    // 两种宿主送的一样就只存一份，不一样的分开存，差异一眼看得到。
    const same = JSON.stringify(runs.node) === JSON.stringify(runs.serverless);
    check(name, same ? { both: runs.node } : runs);
  });
});

describe('登录时的安卓客户端请求', () => {
  const record = async (name: string, run: (http: AuthHttpClient) => Promise<unknown>) => {
    const posts: unknown[] = [];
    const http = {
      post: async (url: string, data: unknown, config: { headers?: unknown } = {}) => {
        // 带长整数的请求体是先序列化好的字符串，原样留着才看得出数字有没有失真。
        posts.push({ url, headers: config.headers, body: data });
        return { status: 200, data: { code: 0, req_0: { code: 0, data: {} } } };
      },
    } as unknown as AuthHttpClient;
    await run(http).catch(() => undefined);
    check(name, posts);
  };
  const device = () => ({ ...WIRE_DEVICE });

  it('login/get-session', () =>
    record('login/get-session', (http) => refreshAndroidSession(http, device())));
  it('login/create-qr', () => record('login/create-qr', (http) => createNativeQr(http, device())));
  it('login/exchange-mobile-qq', () =>
    record('login/exchange-mobile-qq', (http) =>
      exchangeCredential(http, device(), 'fixture-qr-id', '10000', 'fixture-qr-token'),
    ));
  it('login/exchange-app-qq-account', () =>
    record('login/exchange-app-qq-account', (http) =>
      exchangeAppCredential(http, device(), 'fixture-qr-id', '10000', 'fixture-qr-token', 2),
    ));
  it('login/exchange-app-wechat-account', () =>
    record('login/exchange-app-wechat-account', (http) =>
      exchangeAppCredential(http, device(), 'fixture-qr-id', WECHAT_ID, 'fixture-qr-token', 1),
    ));
  it('login/exchange-wechat', () =>
    record('login/exchange-wechat', (http) =>
      exchangeWechatCredential(http, device(), 'fixture-wechat-code'),
    ));
});

it('记录里没有多出来的旧条目', () => {
  if (UPDATE) return;
  expect(Object.keys(golden).sort()).toEqual(Object.keys(produced).sort());
});
