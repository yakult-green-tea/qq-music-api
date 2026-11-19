import './helpers/sessionRoutes';
import musicPlayOperationController from '../src/controllers/musicPlayOperation';
import { getMusicPlay } from '../src/routes/operations/getMusicPlay';
import { CATALOG_RUNTIMES } from './helpers/catalogRoutes';
import { createParityRunner } from './helpers/operationParity';
import { type SessionCall, useSessionUpstream } from './helpers/sessionRoutes';

// 会员取不到完整歌曲时的备援：同一个账号在 App（安卓）身份被挡的歌，官方网页播放器能放完整歌曲。
// 安卓身份明确回 104003 时，用同一个文件名、换官方网页播放器身份再要一次（参数照网页多带 loginflag 1、
// platform "20"）；拿到就回完整链接，source.protocol 标 web-session-vkey。两个宿主行为一致。
const parity = createParityRunner(
  { name: 'getMusicPlay', node: '/getMusicPlay/:songmid?', serverless: '/getMusicPlay/:songmid?' },
  { operation: getMusicPlay, operationNode: musicPlayOperationController },
);

type PlayBody = { data: { playUrl: Record<string, Record<string, unknown>> } };
const playUrlOf = (body: unknown) => (body as PlayBody).data.playUrl;
const vkeyCallsOf = (calls: SessionCall[]) =>
  calls.flatMap((call) => call.rpc).filter((rpc) => rpc.method === 'UrlGetVkey');
const isWebCall = (rpc: { param: Record<string, unknown> }) =>
  rpc.param.loginflag === 1 && rpc.param.platform === '20';

type Reply = { data?: unknown; code?: number; httpStatus?: number };
const SIP = 'https://stream.invalid/';
const refused = (mid: string): Reply => ({
  data: { sip: [SIP], midurlinfo: [{ songmid: mid, purl: '', result: 104003, subcode: 1 }] },
});
const granted = (mid: string, purl: string): Reply => ({
  data: { sip: [SIP], midurlinfo: [{ songmid: mid, purl, result: 0 }] },
});
const MEDIA = 'FixtureMedia01';
/** 真的 mid 只有英文字母和数字；文件名认得出来，备援才会采用。 */
const SONG = 'fixtureSongMidA1';

describe.each(
  CATALOG_RUNTIMES,
)('/getMusicPlay 取不到完整歌曲时换网页播放器身份（%s）', (runtime) => {
  const upstream = useSessionUpstream(runtime);
  beforeEach(() =>
    jest
      .spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValue('00000000-0000-4000-8000-000000000001'),
  );
  const play = async (query: string, replies: Reply[], fallback = true) => {
    upstream.state.playbackFallbackEnabled = fallback;
    const options = await upstream.options('valid');
    return parity(runtime, `/getMusicPlay/${query}`, upstream.calls, {
      ...options,
      beforeEachLeg: async () => {
        await options.beforeEachLeg?.();
        upstream.state.rpcReplyQueues = { UrlGetVkey: [...replies] };
      },
    });
  };

  it.each([
    ['320', 'M800', '.mp3'],
    ['flac', 'F000', '.flac'],
  ])('%s 明确 104003：网页身份拿到完整文件就回链接', async (quality, prefix, ext) => {
    const purl = `${prefix}${SONG}${MEDIA}${ext}?vkey=fixture`;
    const legs = await play(`${SONG}?quality=${quality}&mediaId=${MEDIA}`, [
      refused(SONG),
      granted(SONG, purl),
    ]);
    const vkeys = vkeyCallsOf(legs.operation.calls);
    expect(vkeys.map(isWebCall)).toEqual([false, true]);
    expect(vkeys[1].param.filename).toEqual(vkeys[0].param.filename);
    expect(legs.operation.status).toBe(200);
    expect(playUrlOf(legs.operation.body)[SONG]).toMatchObject({
      url: `${SIP}${purl}`,
      error: false,
      source: { kind: 'full', protocol: 'web-session-vkey', cdn: 'response-sip' },
    });
    expect(legs.host).toEqual(legs.operation);
  });

  it('128：再取一次仍被拒之后，才换网页身份', async () => {
    upstream.state.songDetails = {};
    const purl = `M500${SONG}${MEDIA}.mp3?vkey=fixture`;
    const legs = await play(`${SONG}?quality=128&mediaId=${MEDIA}`, [
      refused(SONG),
      refused(SONG),
      granted(SONG, purl),
    ]);
    expect(vkeyCallsOf(legs.operation.calls).map(isWebCall)).toEqual([false, false, true]);
    expect(playUrlOf(legs.operation.body)[SONG]).toMatchObject({
      url: `${SIP}${purl}`,
      source: { protocol: 'web-session-vkey' },
    });
    expect(legs.host).toEqual(legs.operation);
  });

  it('网页身份也被拒：回原来的结果', async () => {
    const legs = await play(`${SONG}?quality=320&mediaId=${MEDIA}`, [refused(SONG), refused(SONG)]);
    expect(vkeyCallsOf(legs.operation.calls).map(isWebCall)).toEqual([false, true]);
    expect(playUrlOf(legs.operation.body)[SONG]).toMatchObject({
      url: '',
      error: '暂无播放链接',
      source: { protocol: 'android-vkey', cdn: 'none' },
    });
    expect(legs.host).toEqual(legs.operation);
  });

  it('关掉备援：不换网页身份', async () => {
    const legs = await play(
      `${SONG}?quality=320&mediaId=${MEDIA}`,
      [refused(SONG), granted(SONG, `M800${SONG}${MEDIA}.mp3?vkey=fixture`)],
      false,
    );
    expect(vkeyCallsOf(legs.operation.calls).map(isWebCall)).toEqual([false]);
    expect(playUrlOf(legs.operation.body)[SONG]).toMatchObject({ url: '' });
  });
});
