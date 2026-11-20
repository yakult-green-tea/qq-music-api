import './helpers/sessionRoutes';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import musicPlayOperationController from '../src/controllers/musicPlayOperation';
import { getMusicPlay } from '../src/routes/operations/getMusicPlay';
import { CATALOG_RUNTIMES } from './helpers/catalogRoutes';
import { createParityRunner } from './helpers/operationParity';
import { type SessionCall, useSessionUpstream } from './helpers/sessionRoutes';

// 试听：前端带 preview=1 时改要试听文件（RS02 前缀、只有一段 14 字元），拿到链接的歌标上 preview: true。
// 要之前先查单曲详情：只有确认 size_try > 0、又有可信的 media id（前端给的有效 mediaId，否则详情里的
// media_mid）才去要；其他的不要试听文件，直接回 url_unavailable＋「试听不可用」那句，不拿 songmid 猜文件名。
// 不带 preview 时请求和回应都和以前一样。
const parity = createParityRunner(
  { name: 'getMusicPlay', node: '/getMusicPlay/:songmid?', serverless: '/getMusicPlay/:songmid?' },
  {
    operation: getMusicPlay,
    operationNode: musicPlayOperationController,
  },
);
const uuid = '00000000-0000-4000-8000-000000000001';

const MEDIA_A = 'MediaFixtureA1';
const MEDIA_B = 'MediaFixtureB1';
const CALLER_MEDIA = 'CallerMediaId1';

const track = (sizeTry: unknown, mediaMid: unknown) => ({
  mid: 'fixture-detail',
  file: { size_try: sizeTry, media_mid: mediaMid, e_30s: 60000 },
});

/** a 有试听；b 的 size_try 是 0；c 有试听但没有可用的 media_mid。 */
const DETAILS = {
  'fixture-a': track(960887, MEDIA_A),
  'fixture-b': track(0, MEDIA_B),
  'fixture-c': track(481070, ''),
};

const PREVIEW_UNAVAILABLE = {
  url: '',
  error: '暂无播放链接',
  restriction: {
    key: 'url_unavailable',
    evidence: 'observed-response',
    hint: {
      key: 'playback.preview-unavailable',
      message: "A preview isn't available for this song, or the reason isn't confirmed yet.",
    },
  },
};

/** 带会话、详情可靠且 size_try 是 0：确定这首没有试听文件。 */
const PREVIEW_MISSING = {
  ...PREVIEW_UNAVAILABLE,
  restriction: {
    ...PREVIEW_UNAVAILABLE.restriction,
    hint: { key: 'playback.preview-missing', message: 'This song has no preview.' },
  },
};

type PlayBody = { data: { playUrl: Record<string, Record<string, unknown>> } };
const playUrlOf = (body: unknown) => (body as PlayBody).data.playUrl;

const VKEY_METHODS = ['UrlGetVkey', 'CgiGetVkey'];
const vkeyCallsOf = (calls: SessionCall[]) =>
  calls.flatMap((call) => call.rpc).filter((rpc) => VKEY_METHODS.includes(rpc.method));
const filenamesOf = (calls: SessionCall[]) => vkeyCallsOf(calls)[0]?.param.filename;
const detailLookupsOf = (calls: SessionCall[]) =>
  calls
    .flatMap((call) => call.rpc)
    .filter((rpc) => rpc.method === 'get_song_detail_yqq')
    .map((rpc) => rpc.param.song_mid);

const granted = (songmid: string, media: string) => ({
  songmid,
  purl: `RS02${media}.mp3?vkey=fixture`,
});

it('文档与 Explorer 说明确定没有试听文件的提示', () => {
  const readme = readFileSync(resolve(__dirname, '../docs/README.md'), 'utf8');
  expect(readme).toContain('playback.preview-missing');
  const explorer = readFileSync(resolve(__dirname, '../src/config/apiExplorer.ts'), 'utf8');
  expect(explorer).toContain('playback.preview-missing');
});

describe.each(CATALOG_RUNTIMES)('/getMusicPlay 试听（%s）', (runtime) => {
  const upstream = useSessionUpstream(runtime);
  beforeEach(() => {
    jest.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(uuid);
    upstream.state.songDetails = DETAILS;
  });

  const play = async (query: string, session: 'valid' | 'missing' = 'valid') =>
    parity(
      runtime,
      `/getMusicPlay/${query}`,
      upstream.calls,
      session === 'valid' ? await upstream.options() : await upstream.options('missing'),
    );

  it('带会话：只对有试听的歌要试听文件，size_try 0 的直接回没有试听文件', async () => {
    upstream.state.data = {
      sip: ['https://stream.invalid/'],
      midurlinfo: [granted('fixture-a', MEDIA_A)],
    };

    const legs = await play('fixture-a,fixture-b?preview=1');

    expect(legs.operation.status).toBe(200);
    expect(detailLookupsOf(legs.operation.calls).sort()).toEqual(['fixture-a', 'fixture-b']);
    expect(filenamesOf(legs.operation.calls)).toEqual([`RS02${MEDIA_A}.mp3`]);
    expect(vkeyCallsOf(legs.operation.calls)[0].param.songmid).toEqual(['fixture-a']);
    expect(playUrlOf(legs.operation.body)).toEqual({
      'fixture-a': {
        url: `https://stream.invalid/RS02${MEDIA_A}.mp3?vkey=fixture`,
        error: false,
        preview: true,
        // 3.3.7：认出 RS02 文件名就交实际音质和格式；详情宣告的试听长度（e_30s）一起交，片段位置不交。
        source: {
          kind: 'preview',
          protocol: 'preview-rs02',
          cdn: 'response-sip',
          quality: 'preview',
          codec: 'mp3',
          trial: { durationMs: 60000 },
        },
      },
      'fixture-b': PREVIEW_MISSING,
    });
    expect(legs.host).toEqual(legs.operation);
  });

  it('3.3.8：详情的 b_30s 不是 0 时，试听长度是 e_30s − b_30s，起止不交，两个宿主一样', async () => {
    upstream.state.songDetails = {
      'fixture-a': {
        mid: 'fixture-detail',
        file: { size_try: 960887, media_mid: MEDIA_A, b_30s: 69000, e_30s: 129000 },
      },
    };
    upstream.state.data = {
      sip: ['https://stream.invalid/'],
      midurlinfo: [granted('fixture-a', MEDIA_A)],
    };

    const legs = await play('fixture-a?preview=1');

    expect(legs.operation.status).toBe(200);
    expect(playUrlOf(legs.operation.body)['fixture-a'].source).toEqual({
      kind: 'preview',
      protocol: 'preview-rs02',
      cdn: 'response-sip',
      quality: 'preview',
      codec: 'mp3',
      trial: { durationMs: 60000 },
    });
    expect(legs.host).toEqual(legs.operation);
  });

  it.each([
    ['size_try 是数字 0', track(0, MEDIA_B), ''],
    ['size_try 是字符串 "0"', track('0', MEDIA_B), ''],
    ['前端给了有效 mediaId 也一样', track(0, MEDIA_B), `&mediaId=${CALLER_MEDIA}`],
    ['没有 media_mid 也一样', track(0, ''), ''],
  ])('带会话：%s 时确定没有试听文件，不去要', async (_label, detail, mediaQuery) => {
    upstream.state.songDetails = { 'fixture-b': detail };
    upstream.state.data = { sip: ['https://stream.invalid/'], midurlinfo: [] };

    const legs = await play(`fixture-b?preview=1${mediaQuery}`);

    expect(legs.operation.status).toBe(200);
    expect(vkeyCallsOf(legs.operation.calls)).toEqual([]);
    expect(legs.operation.body).toEqual({ data: { playUrl: { 'fixture-b': PREVIEW_MISSING } } });
    expect(legs.host).toEqual(legs.operation);
  });

  it('带会话：超过 10 首查询上限、没查详情的 size_try 0 歌仍是试听不可用', async () => {
    const mids = Array.from({ length: 11 }, (_, index) => `fixture-${index}`);
    upstream.state.songDetails = Object.fromEntries(mids.map((mid) => [mid, track(0, MEDIA_A)]));
    upstream.state.data = { sip: ['https://stream.invalid/'], midurlinfo: [] };

    const legs = await play(`${mids.join(',')}?preview=1`);

    expect(playUrlOf(legs.operation.body)['fixture-0']).toEqual(PREVIEW_MISSING);
    expect(playUrlOf(legs.operation.body)['fixture-10']).toEqual(PREVIEW_UNAVAILABLE);
  });

  it.each([
    ['有效的 mediaId 优先', `&mediaId=${CALLER_MEDIA}`, CALLER_MEDIA],
    ['格式不对的 mediaId 当没给', '&mediaId=fixture-media', MEDIA_A],
    ['太短的 mediaId 当没给', '&mediaId=Short1', MEDIA_A],
    ['没给 mediaId 用详情里的 media_mid', '', MEDIA_A],
  ])('带会话：%s', async (_label, mediaQuery, media) => {
    upstream.state.data = {
      sip: ['https://stream.invalid/'],
      midurlinfo: [granted('fixture-a', media)],
    };

    const legs = await play(`fixture-a?preview=true${mediaQuery}`);

    expect(filenamesOf(legs.operation.calls)).toEqual([`RS02${media}.mp3`]);
    expect(playUrlOf(legs.operation.body)['fixture-a']).toMatchObject({ preview: true });
  });

  it.each([
    ['没有可信的 media_mid', 'fixture-c', DETAILS],
    ['详情里没有这首歌', 'fixture-a', {}],
    ['size_try 不是数字', 'fixture-a', { 'fixture-a': track('many', MEDIA_A) }],
    ['size_try 是负数', 'fixture-a', { 'fixture-a': track(-1, MEDIA_A) }],
  ])('带会话：%s 时不要试听文件、也不拿 songmid 猜', async (_label, mid, details) => {
    upstream.state.songDetails = details;
    upstream.state.data = { sip: ['https://stream.invalid/'], midurlinfo: [] };

    const legs = await play(`${mid}?preview=1`);

    expect(legs.operation.status).toBe(200);
    expect(vkeyCallsOf(legs.operation.calls)).toEqual([]);
    expect(legs.operation.body).toEqual({ data: { playUrl: { [mid]: PREVIEW_UNAVAILABLE } } });
    expect(legs.host).toEqual(legs.operation);
  });

  it('带会话：有试听的歌上游仍没给链接，也回试听不可用那句', async () => {
    upstream.state.data = {
      sip: ['https://stream.invalid/'],
      midurlinfo: [{ songmid: 'fixture-a', purl: '', result: 104003 }],
    };

    const legs = await play('fixture-a?preview=1');

    expect(playUrlOf(legs.operation.body)['fixture-a']).toEqual({
      ...PREVIEW_UNAVAILABLE,
      restriction: { ...PREVIEW_UNAVAILABLE.restriction, codes: { result: 104003 } },
      source: { kind: 'preview', protocol: 'preview-rs02', cdn: 'none' },
    });
  });

  it('带会话：一次最多查 10 首的详情，后面的歌当作查不到', async () => {
    const mids = Array.from({ length: 11 }, (_, index) => `fixture-${index}`);
    upstream.state.songDetails = Object.fromEntries(mids.map((mid) => [mid, track(1, MEDIA_A)]));
    upstream.state.data = {
      sip: ['https://stream.invalid/'],
      midurlinfo: mids.slice(0, 10).map((mid) => granted(mid, MEDIA_A)),
    };

    const legs = await play(`${mids.join(',')}?preview=1`);

    expect(detailLookupsOf(legs.operation.calls)).toHaveLength(10);
    expect(vkeyCallsOf(legs.operation.calls)[0].param.songmid).toEqual(mids.slice(0, 10));
    expect(playUrlOf(legs.operation.body)['fixture-10']).toEqual(PREVIEW_UNAVAILABLE);
  });

  it.each([
    '',
    '?preview=0',
    '?preview=',
    '?preview=yes',
  ])('带会话 %s 不是试听请求，文件名和回应都照旧、不查详情', async (query) => {
    upstream.state.data = {
      sip: ['https://stream.invalid/'],
      midurlinfo: [{ songmid: 'fixture-a', purl: 'fixture.mp3' }],
    };

    const legs = await play(`fixture-a${query}`);

    expect(filenamesOf(legs.operation.calls)).toEqual(['M500fixture-afixture-a.mp3']);
    expect(detailLookupsOf(legs.operation.calls)).toEqual([]);
    expect(legs.operation.body).toEqual({
      data: {
        playUrl: {
          'fixture-a': {
            url: 'https://stream.invalid/fixture.mp3',
            error: false,
            source: { kind: 'full', protocol: 'android-vkey', cdn: 'response-sip' },
          },
        },
      },
    });
  });

  if (runtime === 'node') {
    it('匿名带 preview=1 同样先查详情，只要有试听的歌；size_try 0 仍只说试听不可用', async () => {
      upstream.state.anonymousPlay = {
        code: 0,
        req_0: {
          code: 0,
          data: { sip: ['https://stream.invalid/'], midurlinfo: [granted('fixture-a', MEDIA_A)] },
        },
      };

      const legs = await play('fixture-a,fixture-b?preview=1&mediaId=fixture-media', 'missing');

      expect(detailLookupsOf(legs.operation.calls).sort()).toEqual(['fixture-a', 'fixture-b']);
      expect(filenamesOf(legs.operation.calls)).toEqual([`RS02${MEDIA_A}.mp3`]);
      expect(vkeyCallsOf(legs.operation.calls)[0].param.songmid).toEqual(['fixture-a']);
      expect(playUrlOf(legs.operation.body)).toEqual({
        'fixture-a': {
          url: `https://stream.invalid/RS02${MEDIA_A}.mp3?vkey=fixture`,
          error: false,
          preview: true,
        },
        'fixture-b': PREVIEW_UNAVAILABLE,
      });
      expect(legs.host).toEqual(legs.operation);
    });

    it('匿名：全部都没有试听时不打取链接的请求', async () => {
      const legs = await play('fixture-b?preview=1', 'missing');

      expect(vkeyCallsOf(legs.operation.calls)).toEqual([]);
      expect(legs.operation.body).toEqual({
        data: { playUrl: { 'fixture-b': PREVIEW_UNAVAILABLE } },
      });
    });
  }
});
