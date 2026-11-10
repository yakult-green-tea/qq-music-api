import './helpers/wireRecorder';
import { CATALOG_RUNTIMES } from './helpers/catalogRoutes';
import { CONTRACT_CREDENTIAL } from './helpers/contractUpstream';
import { type RecordedCall, runOnWire, useWireRecorder } from './helpers/wireRecorder';

// 带会话取播放链接的现状基准。这里记的是当前版本实际怎么处理上游回应，包括几处偏宽松的地方：
// 有链接就当成功、不核对回应里的歌是不是请求的那几首、探测全失败仍拼出一个地址。
// 这些行为以后要收紧时，先改这里的预期并写明原因，不要让它们在别的改动里悄悄变掉。

type PlayUrl = Record<string, Record<string, unknown>>;
const playUrlOf = (body: unknown) => (body as { data: { playUrl: PlayUrl } }).data.playUrl;
const A = 'fixtureSongMidA1';
const B = 'fixtureSongMidB2';
const OTHER = 'fixtureSongMidZ9';
const SIP = 'https://stream.invalid/';
const DEFAULT_HOST = 'http://dl.stream.qqmusic.qq.com/';
const PREFERRED_HOST = 'http://sjy6.stream.qqmusic.qq.com/';

const vkeyCallsOf = (calls: RecordedCall[]) =>
  calls
    .map(
      (call) =>
        (call.json as { req_0?: { method?: string; param?: Record<string, unknown> } })?.req_0,
    )
    .filter((rpc) => rpc?.method === 'UrlGetVkey');
const probesOf = (calls: RecordedCall[]) =>
  calls.filter((call) => call.headers.range !== undefined).map((call) => call.url);

describe.each(CATALOG_RUNTIMES)('带会话取播放链接的现状基准（%s）', (runtime) => {
  useWireRecorder();
  const play = (query: string, script: Parameters<typeof runOnWire>[2]) =>
    runOnWire(runtime, `/getMusicPlay/${query}`, script, CONTRACT_CREDENTIAL);

  it('完整链接的条目只有 url 和 error 两个字段', async () => {
    const run = await play(A, {
      rpc: { UrlGetVkey: { sip: [SIP], midurlinfo: [{ songmid: A, purl: 'a.audio' }] } },
    });
    expect(run.status).toBe(200);
    expect(run.body).toEqual({
      data: { playUrl: { [A]: { url: `${SIP}a.audio`, error: false } } },
    });
  });

  it('试听链接多一个 preview: true，没有片段起止时间', async () => {
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
      [A]: { url: `${SIP}try.audio`, error: false, preview: true },
    });
  });

  it('有链接就当成功，不看这一条的 result', async () => {
    const run = await play(A, {
      rpc: {
        UrlGetVkey: {
          sip: [SIP],
          midurlinfo: [{ songmid: A, purl: 'a.audio', result: 104003, subcode: 1 }],
        },
      },
    });
    expect(playUrlOf(run.body)).toEqual({ [A]: { url: `${SIP}a.audio`, error: false } });
    expect(vkeyCallsOf(run.calls)).toHaveLength(1);
  });

  it('回应里多出没请求的歌，照样放进结果', async () => {
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
      [A]: { url: `${SIP}a.audio`, error: false },
      [OTHER]: { url: `${SIP}other.audio`, error: false },
    });
  });

  it('回应里少了请求的歌，结果里就没有那一首', async () => {
    const run = await play(`${A},${B}`, {
      rpc: { UrlGetVkey: { sip: [SIP], midurlinfo: [{ songmid: A, purl: 'a.audio' }] } },
    });
    expect(Object.keys(playUrlOf(run.body))).toEqual([A]);
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
    expect(playUrlOf(run.body)).toEqual({ [A]: { url: `${SIP}second.audio`, error: false } });
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
    expect(playUrlOf(run.body)[A]).toEqual({ url: `${PREFERRED_HOST}a.audio`, error: false });
    expect(probesOf(run.calls)).toEqual([`${PREFERRED_HOST}a.audio`]);
  });

  it('没有 sip、探测全部失败，仍用默认主机拼出地址并当成功', async () => {
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
    expect(playUrlOf(run.body)).toEqual({ [A]: { url: `${DEFAULT_HOST}a.audio`, error: false } });
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
      [A]: { url: `${PREFERRED_HOST}a.audio`, error: false },
      [B]: { url: `${PREFERRED_HOST}b.audio`, error: false },
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
      [A]: { url: 'https://retry.invalid/retry.audio', error: false },
    });
  });

  it('没链接的条目带 restriction，字段只有 key、evidence、codes、hint', async () => {
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
          hint: {
            key: 'playback.reason-unconfirmed',
            message: "This song can't be played right now. The exact reason isn't confirmed yet.",
          },
        },
      },
    });
    expect(vkeyCallsOf(run.calls)).toHaveLength(1);
  });
});
