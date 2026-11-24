import './helpers/sessionRoutes';
import musicPlayOperationController from '../src/controllers/musicPlayOperation';
import { getMusicPlay } from '../src/routes/operations/getMusicPlay';
import { CATALOG_RUNTIMES } from './helpers/catalogRoutes';
import { createParityRunner } from './helpers/operationParity';
import { useSessionUpstream } from './helpers/sessionRoutes';

const parity = createParityRunner(
  { name: 'getMusicPlay', node: '/getMusicPlay/:songmid?', serverless: '/getMusicPlay/:songmid?' },
  { operation: getMusicPlay, operationNode: musicPlayOperationController },
);
const detail = (sw: unknown, msgid: unknown, alert: unknown, pay: unknown) => ({
  action: { switch: sw, msgid, alert },
  pay: { pay_play: pay },
});
const cases = [
  [1, 23, 0, 0, 'playback.maybe-region-restricted'],
  [0x301, 0, 35, 0, 'playback.maybe-region-restricted'],
  [0x301, 0, 35, 1, 'playback.maybe-region-restricted'],
  [0x101d701, 13, 21, 1, 'playback.maybe-membership'],
  [0x101d701, 13, 41, 1, 'playback.maybe-membership'],
  [0x1019701, 13, 41, 1, 'playback.maybe-membership'],
  [0x101d701, 13, 35, 1, 'playback.reason-unconfirmed'],
  [0x101d703, 13, 41, 1, 'playback.reason-unconfirmed'],
  // switch 带 bit 27（0x8000000）：官方各端都放不了（下架、只剩 MV），见 3.3.9 的对照。
  [0x8010001, 3, 0, 1, 'playback.maybe-taken-down'],
  [141671807, 0, 0, 0, 'playback.maybe-taken-down'],
  [0x10001, 3, 0, 0, 'playback.reason-unconfirmed'],
  [1, 0, 0, 0, 'playback.reason-unconfirmed'],
  [1, 23, undefined, 0, 'playback.reason-unconfirmed'],
] as const;

describe.each(CATALOG_RUNTIMES)('完整播放提示特征（%s）', (runtime) => {
  const upstream = useSessionUpstream(runtime);
  const play = async (query = '', mode: 'valid' | 'missing' = 'valid') =>
    parity(
      runtime,
      `/getMusicPlay/fixture-song${query}`,
      upstream.calls,
      await upstream.options(mode),
    );
  const hintOf = (body: unknown) => (body as any).data.playUrl['fixture-song'].restriction.hint.key;
  beforeEach(() => {
    jest
      .spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValue('00000000-0000-4000-8000-000000000001');
    upstream.state.data = {
      sip: ['https://stream.invalid/'],
      midurlinfo: [{ songmid: 'fixture-song', purl: '', result: 104003, subcode: 1 }],
    };
  });
  describe.each([2, 1])('凭证类型 %s', (loginType) => {
    it.each(
      cases,
    )('switch %s msgid %s alert %s pay %s → %s', async (sw, msgid, alert, pay, expected) => {
      upstream.state.credentialLoginType = loginType;
      upstream.state.songDetails = { 'fixture-song': detail(sw, msgid, alert, pay) };
      const legs = await play();
      expect(legs.operation.status).toBe(200);
      expect(hintOf(legs.operation.body)).toBe(expected);
      expect((legs.operation.body as any).data.playUrl['fixture-song'].restriction).toMatchObject({
        key: 'url_unavailable',
        evidence: 'observed-response',
        codes: { result: 104003, subcode: 1 },
      });
      expect(legs.host).toEqual(legs.operation);
    });
  });
  it.each(['320', 'flac'])('音质 %s 不查原因详情', async (quality) => {
    const legs = await play(`?quality=${quality}`);
    expect(hintOf(legs.operation.body)).toBe('playback.reason-unconfirmed');
    expect(
      upstream.calls.flatMap((c) => c.rpc).filter((r) => r.method === 'get_song_detail_yqq'),
    ).toHaveLength(0);
  });
  it('功能开关关闭时不查详情、保持未知提示', async () => {
    upstream.state.playbackHintsEnabled = false;
    upstream.state.songDetails = { 'fixture-song': detail(1, 23, 0, 0) };
    const legs = await play();
    expect(hintOf(legs.operation.body)).toBe('playback.reason-unconfirmed');
    expect(
      upstream.calls.flatMap((c) => c.rpc).filter((r) => r.method === 'get_song_detail_yqq'),
    ).toHaveLength(0);
    expect(legs.host).toEqual(legs.operation);
  });
  it('单一 104003 不足以判断，其他错误码也不套提示', async () => {
    upstream.state.songDetails = { 'fixture-song': detail(1, 23, 0, 0) };
    upstream.state.data = { midurlinfo: [{ songmid: 'fixture-song', purl: '', result: 104003 }] };
    expect(hintOf((await play()).operation.body)).toBe('playback.reason-unconfirmed');
  });
  it('m4a 同规则，超过十首不查且保持未知', async () => {
    const mids = Array.from({ length: 12 }, (_, index) => `fixture-${index}`);
    upstream.state.data = {
      midurlinfo: mids.map((songmid) => ({ songmid, purl: '', result: 104003, subcode: 1 })),
    };
    upstream.state.songDetails = Object.fromEntries(mids.map((mid) => [mid, detail(1, 23, 0, 0)]));
    const legs = await parity(
      runtime,
      `/getMusicPlay/${mids.join(',')}?quality=m4a`,
      upstream.calls,
      await upstream.options(),
    );
    expect(
      legs.operation.calls.flatMap((c) => c.rpc).filter((r) => r.method === 'get_song_detail_yqq'),
    ).toHaveLength(10);
    expect(legs.host).toEqual(legs.operation);
    const urls = (legs.operation.body as any).data.playUrl;
    expect(urls['fixture-9'].restriction.hint.key).toBe('playback.maybe-region-restricted');
    expect(urls['fixture-10'].restriction.hint.key).toBe('playback.reason-unconfirmed');
  });
  if (runtime === 'node')
    it('匿名路径不套用带会话规则、不查原因详情', async () => {
      upstream.state.anonymousPlay = { req_0: { data: upstream.state.data } };
      upstream.state.songDetails = { 'fixture-song': detail(1, 23, 0, 0) };
      const legs = await play('', 'missing');
      expect(hintOf(legs.operation.body)).toBe('playback.reason-unconfirmed');
      expect(
        upstream.calls.flatMap((c) => c.rpc).filter((r) => r.method === 'get_song_detail_yqq'),
      ).toHaveLength(0);
    });
});
