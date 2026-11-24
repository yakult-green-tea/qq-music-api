import fs from 'node:fs';
import path from 'node:path';

/**
 * Keeps the default suite honest about what it proves.
 *
 * The promoted route tests use synthetic upstream replies and exact response assertions.
 * Any future live probes must stay outside the default suite and its network guard.
 */

const ROOT = path.join(__dirname, '..');
const ROOT_DIR_TOKEN = '<rootDir>';
const OFFLINE_SETUP = `${ROOT_DIR_TOKEN}/tests/helpers/offlineNetwork.cjs`;

const PROMOTED_ROUTE_TESTS = ['getLyric.test.ts'];

/** Folia calls these routes, so their tests stay in the default suite as upstream-stubbed contracts. */
const FOLIA_ROUTE_TESTS = [
  'getSingerAlbum.test.ts',
  'getSingerHotsong.test.ts',
  'getSongInfo.test.ts',
];

/**
 * Folia 会调用的路由（folia-major `950e0209` 的 qqTransport.ts，51 条；后来 QQ 音源加了替代歌曲 /song/replacement），每条对应 test:contracts 里
 * 守着它回包形状的测试。Folia 加了新路由，就在这里加一行，并把测试放进 test:contracts。
 * 值是 [测试文件, 文件里要出现的路径写法]；路径是拼出来的才另写。
 */
const FOLIA_ROUTE_CONTRACTS: Record<string, [string, string?]> = {
  '/getAlbumInfo': ['tests/folia.http-contracts.test.ts'],
  '/getMusicPlay': ['tests/operations.music-play-retry.test.ts'],
  '/getSingerAlbum': ['tests/getSingerAlbum.test.ts'],
  '/getSingerHotsong': ['tests/getSingerHotsong.test.ts'],
  '/getSongInfo': ['tests/folia.http-contracts.test.ts'],
  '/getSongListDetail': ['tests/folia.http-contracts.test.ts'],
  '/login/channels': ['tests/operations.login-channels.test.ts'],
  '/login/qr/cancel': ['tests/folia.http-contracts.test.ts'],
  '/login/qr/check': ['tests/folia.login-contracts.test.ts'],
  '/login/qr/create': ['tests/folia.login-contracts.test.ts'],
  '/login/qr/key': ['tests/folia.login-contracts.test.ts'],
  '/login/refresh': ['tests/login.refresh.routes.test.ts'],
  '/login/status': ['tests/folia.http-contracts.test.ts'],
  '/logout': ['tests/folia.http-contracts.test.ts'],
  '/radio/list': ['tests/radio.routes.test.ts'],
  '/radio/tracks': ['tests/radio.routes.test.ts'],
  '/recommend/categories': ['tests/recommend-catalog.routes.test.ts'],
  '/recommend/category-playlists': ['tests/recommend-catalog.routes.test.ts'],
  '/recommend/feed': ['tests/recommend-feed.routes.test.ts'],
  '/recommend/new-albums': ['tests/recommend-new-albums.routes.test.ts'],
  '/recommend/new-songs': ['tests/recommend-catalog.routes.test.ts'],
  '/recommend/playlists': ['tests/folia.http-contracts.test.ts'],
  '/recommend/radar': ['tests/recommend-radar.routes.test.ts'],
  '/recommend/toplist': ['tests/recommend-toplists.routes.test.ts'],
  '/recommend/toplists': ['tests/recommend-toplists.routes.test.ts'],
  '/search': ['tests/search.routes.test.ts'],
  '/song/replacement': ['tests/song-replacement.routes.test.ts'],
  '/song/similar': ['tests/song-relations.routes.test.ts'],
  '/user/album/subscribe': ['tests/album.subscribe.routes.test.ts'],
  '/user/albums': ['tests/folia.http-contracts.test.ts'],
  '/user/blacklist/add': ['tests/blacklist.write.routes.test.ts'],
  '/user/cloud': ['tests/user-cloud.routes.test.ts'],
  '/user/daily-songs': ['tests/daily-songs.routes.test.ts'],
  '/user/daily-songs/history': ['tests/daily-history.routes.test.ts'],
  '/user/daily-songs/history/dates': ['tests/daily-history.routes.test.ts'],
  '/user/detail': ['tests/folia.http-contracts.test.ts'],
  '/user/guess-you-like': ['tests/recommend.routes.test.ts'],
  '/user/guess-you-like/modes': ['tests/guess-you-like.modes.routes.test.ts'],
  '/user/guess-you-like/tracks': ['tests/guess-you-like.mode-tracks.routes.test.ts'],
  '/user/liked-songs': ['tests/folia.http-contracts.test.ts'],
  '/user/listening-rank': ['tests/user.listening-rank.routes.test.ts'],
  '/user/personal-fm': ['tests/recommend-radar.routes.test.ts'],
  '/user/playlist': ['tests/folia.http-contracts.test.ts'],
  '/user/playlist-detail': ['tests/folia.http-contracts.test.ts'],
  '/user/playlist/create': ['tests/playlist.management.routes.test.ts', '/user/playlist/${'],
  '/user/playlist/subscribe': ['tests/subscriptions.routes.test.ts'],
  '/user/playlist/tracks': ['tests/playlist.track-writes.routes.test.ts'],
  '/user/recommendation-preferences': ['tests/recommendation.preferences.routes.test.ts'],
  '/user/recommendation-preferences/update': [
    'tests/recommendation.preferences.write.routes.test.ts',
  ],
  '/user/song/like': ['tests/song.like.routes.test.ts'],
  '/user/subscription-status': ['tests/subscriptions.routes.test.ts'],
  '/user/vip': ['tests/user.vip.routes.test.ts'],
};

const STATUS_SET_ONLY = /expect\(\s*\[[\d\s,]+\]\s*\)\.toContain\(\s*\w+\.status\s*\)/;

const listTests = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listTests(full);
    return /\.test\.[cm]?[jt]s$/.test(entry.name) ? [full] : [];
  });

interface JestConfig {
  testMatch?: string[];
  testPathIgnorePatterns?: string[];
  setupFiles?: string[];
  setupFilesAfterEnv?: string[];
  coverageThreshold?: unknown;
  collectCoverage?: boolean;
}

const loadConfig = (file: string): JestConfig => {
  const full = path.join(ROOT, file);
  delete require.cache[require.resolve(full)];
  return require(full) as JestConfig;
};

const packageScripts = (): Record<string, string> =>
  JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts;

describe('default test suite layout', () => {
  const defaultConfig = loadConfig('jest.config.js');

  const defaultSuiteFiles = () => listTests(path.join(ROOT, 'tests'));

  it('runs the expanded Folia contracts offline in both commands', () => {
    const contracts = packageScripts()['test:contracts'];
    expect(contracts).toContain('--setupFilesAfterEnv ./tests/helpers/offlineNetwork.cjs');
    for (const file of [
      'tests/playlist.track-writes.routes.test.ts',
      'tests/subscriptions.routes.test.ts',
      'tests/recommend.routes.test.ts',
      'tests/daily-songs.routes.test.ts',
      'tests/operations.music-play-controlled-hints.test.ts',
      'tests/services.qr-login.test.ts',
      'tests/operations.qr-check.test.ts',
      'tests/errors.runtime-baseline.test.ts',
      'tests/song.like.routes.test.ts',
      'tests/album.subscribe.routes.test.ts',
      'tests/search.routes.test.ts',
      'tests/folia.login-contracts.test.ts',
      'tests/folia.wiring-contracts.test.ts',
      'tests/operations.music-play-preview.test.ts',
      'tests/operations.login-channels.test.ts',
      'tests/login.refresh.routes.test.ts',
      'tests/user.vip.routes.test.ts',
      'tests/recommend-new-albums.routes.test.ts',
      'tests/recommend-toplists.routes.test.ts',
      'tests/recommend-radar.routes.test.ts',
      'tests/user-cloud.routes.test.ts',
      'tests/playlist.management.routes.test.ts',
      'tests/operations.user-playlist-detail.test.ts',
    ]) {
      expect(contracts.split(' ')).toContain(file);
      expect(defaultSuiteFiles()).toContain(path.join(ROOT, file));
    }
  });

  it('Folia 用到的每条路由都有 test:contracts 里的测试守着', () => {
    const contracts = packageScripts()['test:contracts'].split(' ');
    expect(Object.keys(FOLIA_ROUTE_CONTRACTS)).toHaveLength(52);
    for (const [route, [file, needle = route]] of Object.entries(FOLIA_ROUTE_CONTRACTS)) {
      expect({ route, inContracts: contracts.includes(file) }).toEqual({
        route,
        inContracts: true,
      });
      const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
      expect({ route, mentioned: text.includes(needle) }).toEqual({ route, mentioned: true });
    }
  });

  it('has no status-set-only route test left in the default suite', () => {
    const offenders = defaultSuiteFiles()
      .filter((file) => STATUS_SET_ONLY.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(ROOT, file));

    expect(offenders).toEqual([]);
  });

  it('keeps the Folia route tests in the default suite', () => {
    for (const name of FOLIA_ROUTE_TESTS)
      expect(fs.existsSync(path.join(ROOT, 'tests', name))).toBe(true);
  });

  it('keeps the mocked legacy route contracts in the default suite', () => {
    for (const name of PROMOTED_ROUTE_TESTS)
      expect(fs.existsSync(path.join(ROOT, 'tests', name))).toBe(true);
  });

  it('runs every test offline under one config and the coverage gate', () => {
    expect(fs.readdirSync(ROOT).filter((name) => /^jest\..*config\.[cm]?js$/.test(name))).toEqual([
      'jest.config.js',
    ]);
    expect(defaultConfig.setupFilesAfterEnv).toContain(OFFLINE_SETUP);
    expect(defaultConfig.coverageThreshold).toEqual({
      global: { branches: 50, functions: 50, lines: 75, statements: 75 },
    });
    expect(packageScripts().test).toBe('jest');
  });
});
