import './helpers/wireRecorder';
import { logger } from '../src/util/logger';
import { CATALOG_RUNTIMES } from './helpers/catalogRoutes';
import { CONTRACT_CREDENTIAL } from './helpers/contractUpstream';
import { type RecordedCall, runOnWire, useWireRecorder } from './helpers/wireRecorder';

// 带会话取播放链接怎么处理上游回应的基准。3.3.6 的现状先固定在这里，3.3.7 按决定逐项收紧：
// 回应里多出没请求的歌不再交出去；少了请求的歌补一条明确的空链接；每条从上游来的结果多一个可选的 source，
// 说明是完整、试听还是不确定、走哪种办法、CDN 怎么定的。有链接就当成功、探测全失败仍拼出地址这两处照旧，
// 只在 source 里标出来。以后要再改，先改这里的预期并写明原因，不要让它们在别的改动里悄悄变掉。

type PlayUrl = Record<string, Record<string, unknown>>;
const playUrlOf = (body: unknown) => (body as { data: { playUrl: PlayUrl } }).data.playUrl;
const A = 'fixtureSongMidA1';
const B = 'fixtureSongMidB2';
const OTHER = 'fixtureSongMidZ9';
const SIP = 'https://stream.invalid/';
const DEFAULT_HOST = 'http://dl.stream.qqmusic.qq.com/';
const PREFERRED_HOST = 'http://sjy6.stream.qqmusic.qq.com/';
const UNCONFIRMED = {
  key: 'playback.reason-unconfirmed',
  message: "This song can't be played right now. The exact reason isn't confirmed yet.",
};

const source = (
  kind: 'full' | 'preview' | 'unknown',
  cdn: 'response-sip' | 'probed' | 'unverified-default' | 'none',
  protocol: 'android-vkey' | 'preview-rs02' = 'android-vkey',
) => ({ kind, protocol, cdn });

const vkeyCallsOf = (calls: RecordedCall[]) =>
  calls
    .map(
      (call) =>
        (call.json as { req_0?: { method?: string; param?: Record<string, unknown> } })?.req_0,
    )
    .filter((rpc) => rpc?.method === 'UrlGetVkey');
const probesOf = (calls: RecordedCall[]) =>
  calls.filter((call) => call.headers.range !== undefined).map((call) => call.url);

describe.each(CATALOG_RUNTIMES)('带会话取播放链接的基准（%s）', (runtime) => {
  useWireRecorder();
  const play = (query: string, script: Parameters<typeof runOnWire>[2]) =>
    runOnWire(runtime, `/getMusicPlay/${query}`, script, CONTRACT_CREDENTIAL);

  it('完整链接的条目有 url、error，再加一个可选的 source', async () => {
    const run = await play(A, {
      rpc: { UrlGetVkey: { sip: [SIP], midurlinfo: [{ songmid: A, purl: 'a.audio' }] } },
    });
    expect(run.status).toBe(200);
    expect(run.body).toEqual({
      data: {
        playUrl: {
          [A]: { url: `${SIP}a.audio`, error: false, source: source('full', 'response-sip') },
        },
      },
    });
  });

  it('试听链接带 preview: true，source 标成试听；没有片段起止时间', async () => {
    const run = await play(`${A}?preview=1`, {
      rpc: {
        get_song_detail_yqq: {
          track_info: {
            file: { size_try: 1, media_mid: 'FixtureMedia01', try_begin: 64000, try_end: 94000 },
          },
        },
        UrlGetVkey: { sip: [SIP], midurlinfo: [{ songmid: A, purl: 'try.audio' }] },
      },
    });
    expect(playUrlOf(run.body)).toEqual({
      [A]: {
        url: `${SIP}try.audio`,
        error: false,
        preview: true,
        source: source('preview', 'response-sip', 'preview-rs02'),
      },
    });
  });

  it('有链接却带着失败的结果码：照旧交出链接，source 标成不确定', async () => {
    const run = await play(A, {
      rpc: {
        UrlGetVkey: {
          sip: [SIP],
          midurlinfo: [{ songmid: A, purl: 'a.audio', result: 104003, subcode: 1 }],
        },
      },
    });
    expect(playUrlOf(run.body)).toEqual({
      [A]: { url: `${SIP}a.audio`, error: false, source: source('unknown', 'response-sip') },
    });
    expect(vkeyCallsOf(run.calls)).toHaveLength(1);
  });

  it('回应里多出没请求的歌：不交出去，只记一条带数量的日志', async () => {
    const run = await play(A, {
      rpc: {
        UrlGetVkey: {
          sip: [SIP],
          midurlinfo: [
            { songmid: A, purl: 'a.audio' },
            { songmid: OTHER, purl: 'other.audio' },
          ],
        },
      },
    });
    expect(playUrlOf(run.body)).toEqual({
      [A]: { url: `${SIP}a.audio`, error: false, source: source('full', 'response-sip') },
    });
    expect(jest.mocked(logger.info)).toHaveBeenCalledWith('playback.unrequested-entries', {
      phase: 'get-music-play',
      count: 1,
    });
  });

  it('只请求一首、回应只给了另一首：这首变成没链接，照常降级', async () => {
    const run = await play(A, {
      rpc: { UrlGetVkey: { sip: [SIP], midurlinfo: [{ songmid: OTHER, purl: 'other.audio' }] } },
    });
    expect(playUrlOf(run.body)).toEqual({
      [A]: {
        url: '',
        error: '暂无播放链接',
        restriction: { key: 'url_unavailable', evidence: 'observed-response', hint: UNCONFIRMED },
        source: source('full', 'none'),
      },
    });
    // 回应里没有这首的条目，不算「原因没确认」的那种失败，不再取。
    expect(vkeyCallsOf(run.calls)).toHaveLength(1);
  });

  it('回应里少了请求的歌：补一条空链接，原因未确认，不再取', async () => {
    const run = await play(`${A},${B}`, {
      rpc: { UrlGetVkey: { sip: [SIP], midurlinfo: [{ songmid: A, purl: 'a.audio' }] } },
    });
    expect(playUrlOf(run.body)).toEqual({
      [A]: { url: `${SIP}a.audio`, error: false, source: source('full', 'response-sip') },
      [B]: {
        url: '',
        error: '暂无播放链接',
        restriction: { key: 'url_unavailable', evidence: 'observed-response', hint: UNCONFIRMED },
        source: source('full', 'none'),
      },
    });
    expect(vkeyCallsOf(run.calls)).toHaveLength(1);
  });

  it('要试听、回应里少了那首：补的空链接是「试听不可用」', async () => {
    const run = await play(`${A}?preview=1`, {
      rpc: {
        get_song_detail_yqq: { track_info: { file: { size_try: 1, media_mid: 'FixtureMedia01' } } },
        UrlGetVkey: { sip: [SIP], midurlinfo: [] },
      },
    });
    expect(playUrlOf(run.body)[A]).toMatchObject({
      url: '',
      error: '暂无播放链接',
      restriction: { key: 'url_unavailable', hint: { key: 'playback.preview-unavailable' } },
      source: source('preview', 'none', 'preview-rs02'),
    });
  });

  it('同一首歌回了两条，用后面那条', async () => {
    const run = await play(A, {
      rpc: {
        UrlGetVkey: {
          sip: [SIP],
          midurlinfo: [
            { songmid: A, purl: 'first.audio' },
            { songmid: A, purl: 'second.audio' },
          ],
        },
      },
    });
    expect(playUrlOf(run.body)).toEqual({
      [A]: { url: `${SIP}second.audio`, error: false, source: source('full', 'response-sip') },
    });
  });

  it('回应带 sip 时直接用，不探测；优先用不是 http://ws 开头的那个', async () => {
    const run = await play(A, {
      rpc: {
        UrlGetVkey: {
          sip: ['http://ws.fixture.invalid/', SIP],
          midurlinfo: [{ songmid: A, purl: 'a.audio' }],
        },
      },
    });
    expect(playUrlOf(run.body)[A].url).toBe(`${SIP}a.audio`);
    expect(probesOf(run.calls)).toEqual([]);
  });

  it('没有 sip 时先探测惯用的主机，通了就用它', async () => {
    const run = await play(A, {
      rpc: { UrlGetVkey: { sip: [], midurlinfo: [{ songmid: A, purl: 'a.audio' }] } },
    });
    expect(playUrlOf(run.body)[A]).toEqual({
      url: `${PREFERRED_HOST}a.audio`,
      error: false,
      source: source('full', 'probed'),
    });
    expect(probesOf(run.calls)).toEqual([`${PREFERRED_HOST}a.audio`]);
  });

  it('没有 sip、探测全部失败：仍用默认主机拼出地址，source 标成 CDN 未验', async () => {
    const run = await play(A, {
      rpc: {
        UrlGetVkey: { sip: [], midurlinfo: [{ songmid: A, purl: 'a.audio' }] },
        GetCdnDispatch: { sip: ['http://fixture.stream.qqmusic.qq.com/'] },
      },
      streams: {
        'sjy6.stream.qqmusic.qq.com': 404,
        'fixture.stream.qqmusic.qq.com': 404,
        'dl.stream.qqmusic.qq.com': 404,
      },
    });
    expect(playUrlOf(run.body)).toEqual({
      [A]: {
        url: `${DEFAULT_HOST}a.audio`,
        error: false,
        source: source('full', 'unverified-default'),
      },
    });
    expect(probesOf(run.calls)).toHaveLength(3);
  });

  it('多首歌时只拿第一条有链接的去探测，选到的主机套用到每一首', async () => {
    const run = await play(`${A},${B}`, {
      rpc: {
        UrlGetVkey: {
          sip: [],
          midurlinfo: [
            { songmid: A, purl: 'a.audio' },
            { songmid: B, purl: 'b.audio' },
          ],
        },
      },
    });
    expect(probesOf(run.calls)).toEqual([`${PREFERRED_HOST}a.audio`]);
    expect(playUrlOf(run.body)).toEqual({
      [A]: { url: `${PREFERRED_HOST}a.audio`, error: false, source: source('full', 'probed') },
      [B]: { url: `${PREFERRED_HOST}b.audio`, error: false, source: source('full', 'probed') },
    });
  });

  it('原因没确认时再取的那一次沿用同一个 guid 和文件名，有 sip 就用它的', async () => {
    const run = await play(A, {
      rpc: {
        UrlGetVkey: [
          { sip: [SIP], midurlinfo: [{ songmid: A, purl: '', result: 104003, subcode: 1 }] },
          {
            sip: ['https://retry.invalid/'],
            midurlinfo: [{ songmid: A, purl: 'retry.audio' }],
          },
        ],
      },
    });
    const [first, second] = vkeyCallsOf(run.calls);
    expect(vkeyCallsOf(run.calls)).toHaveLength(2);
    expect(second?.param).toEqual(first?.param);
    expect(playUrlOf(run.body)).toEqual({
      [A]: {
        url: 'https://retry.invalid/retry.audio',
        error: false,
        source: source('full', 'response-sip'),
      },
    });
  });

  it('没链接的条目带 restriction（key、evidence、codes、hint）和 source', async () => {
    const run = await play(`${A}?quality=320`, {
      rpc: {
        UrlGetVkey: {
          sip: [SIP],
          midurlinfo: [{ songmid: A, purl: '', result: 104003, subcode: 1 }],
        },
      },
    });
    expect(playUrlOf(run.body)).toEqual({
      [A]: {
        url: '',
        error: '暂无播放链接',
        restriction: {
          key: 'url_unavailable',
          evidence: 'observed-response',
          codes: { result: 104003, subcode: 1 },
          hint: UNCONFIRMED,
        },
        source: source('full', 'none'),
      },
    });
    expect(vkeyCallsOf(run.calls)).toHaveLength(1);
  });

  it('被文件守门挡下、没向上游要过的歌不带 source', async () => {
    const run = await play(`${A}?preview=1`, {
      rpc: { get_song_detail_yqq: { track_info: { file: { size_try: 0 } } } },
    });
    expect(playUrlOf(run.body)[A]).not.toHaveProperty('source');
    expect(vkeyCallsOf(run.calls)).toHaveLength(0);
  });

  // 实测（两个出口、两个账号）：subcode 只跟着文件名段数走，两段一律 1、一段一律 0，成功失败都一样，
  // 不是原因码。这里固定：完整文件名一律送两段；成功的条目不管 subcode 是几都照常交出。
  it('subcode 不是原因码：两段文件名照送，带 1 或 0 的成功条目一样交出', async () => {
    const run = await play(`${A},${B}`, {
      rpc: {
        UrlGetVkey: {
          sip: [SIP],
          midurlinfo: [
            { songmid: A, purl: 'a.audio', result: 0, subcode: 1 },
            { songmid: B, purl: 'b.audio', result: 0, subcode: 0 },
          ],
        },
      },
    });
    expect(playUrlOf(run.body)).toEqual({
      [A]: { url: `${SIP}a.audio`, error: false, source: source('full', 'response-sip') },
      [B]: { url: `${SIP}b.audio`, error: false, source: source('full', 'response-sip') },
    });
    const [call] = vkeyCallsOf(run.calls);
    expect(call?.param?.filename).toEqual([`M500${A}${A}.mp3`, `M500${B}${B}.mp3`]);
  });
});
