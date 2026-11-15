import './helpers/sessionRoutes';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import musicPlayOperationController from '../src/controllers/musicPlayOperation';
import { getMusicPlay } from '../src/routes/operations/getMusicPlay';
import { CATALOG_RUNTIMES } from './helpers/catalogRoutes';
import { createParityRunner } from './helpers/operationParity';
import { type SessionCall, useSessionUpstream } from './helpers/sessionRoutes';

// 原因没确认时再取一次：只在带会话、m4a／128（含 quality=best 的最后一级）、最终提示是
// reason-unconfirmed 时，用同一会话、同一首、同一音质再要一次，没拿到的歌合成一个请求，每首最多多 1 次。
// 再取仍失败或请求本身出错时，回第一次的结果。
const parity = createParityRunner(
  { name: 'getMusicPlay', node: '/getMusicPlay/:songmid?', serverless: '/getMusicPlay/:songmid?' },
  { operation: getMusicPlay, operationNode: musicPlayOperationController },
);

type PlayBody = { data: { playUrl: Record<string, Record<string, unknown>> } };
const playUrlOf = (body: unknown) => (body as PlayBody).data.playUrl;
const vkeyCallsOf = (calls: SessionCall[]) =>
  calls
    .flatMap((call) => call.rpc)
    .filter((rpc) => ['UrlGetVkey', 'CgiGetVkey'].includes(rpc.method));

type Reply = { data?: unknown; code?: number; httpStatus?: number };
/** 一次取链接请求的回应：列出的歌拿到链接，其他的 104003／1。 */
const vkeyReply = (mids: string[], granted: string[] = []): Reply => ({
  data: {
    sip: ['https://stream.invalid/'],
    midurlinfo: mids.map((songmid) =>
      granted.includes(songmid)
        ? { songmid, purl: `${songmid}.audio` }
        : { songmid, purl: '', result: 104003, subcode: 1 },
    ),
  },
});
const ok = (mid: string) => ({
  url: `https://stream.invalid/${mid}.audio`,
  error: false,
  source: { kind: 'full', protocol: 'android-vkey', cdn: 'response-sip' },
});
const failed = (hint: string) => ({
  url: '',
  error: '暂无播放链接',
  restriction: {
    key: 'url_unavailable',
    evidence: 'observed-response',
    codes: { result: 104003, subcode: 1 },
    hint: { key: hint, message: expect.any(String) },
  },
  source: { kind: 'full', protocol: 'android-vkey', cdn: 'none' },
});
/** 海外被挡的完整详情特征（地区提示规则）。 */
const REGION_DETAIL = { action: { switch: 1, msgid: 23, alert: 0 }, pay: { pay_play: 0 } };
const MEMBERSHIP_DETAIL = {
  action: { switch: 0x101d701, msgid: 13, alert: 21 },
  pay: { pay_play: 1 },
};

it('文档与 Explorer 说明原因没确认时会再取一次', () => {
  const readme = readFileSync(resolve(__dirname, '../docs/README.md'), 'utf8');
  expect(readme).toContain('重新取链一次');
  const explorer = readFileSync(resolve(__dirname, '../src/config/apiExplorer.ts'), 'utf8');
  expect(explorer).toContain('retries once');
});

describe.each(CATALOG_RUNTIMES)('/getMusicPlay 原因没确认时再取一次（%s）', (runtime) => {
  const upstream = useSessionUpstream(runtime);
  beforeEach(() =>
    jest
      .spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValue('00000000-0000-4000-8000-000000000001'),
  );
  const play = async (query: string, replies: Reply[], mode: 'valid' | 'missing' = 'valid') => {
    const options = await upstream.options(mode);
    return parity(runtime, `/getMusicPlay/${query}`, upstream.calls, {
      ...options,
      beforeEachLeg: async () => {
        await options.beforeEachLeg?.();
        upstream.state.rpcReplyQueues = { UrlGetVkey: [...replies] };
      },
    });
  };

  it.each(['', '?quality=128', '?quality=m4a'])('%s：再取一次拿到就回链接', async (query) => {
    upstream.state.songDetails = {};
    const legs = await play(`fixture-a${query}`, [
      vkeyReply(['fixture-a']),
      vkeyReply(['fixture-a'], ['fixture-a']),
    ]);
    const vkeys = vkeyCallsOf(legs.operation.calls);
    expect(vkeys).toHaveLength(2);
    expect(vkeys[1].param.filename).toEqual(vkeys[0].param.filename);
    expect(vkeys[1].param.songmid).toEqual(['fixture-a']);
    expect(legs.operation.status).toBe(200);
    expect(playUrlOf(legs.operation.body)).toEqual({ 'fixture-a': ok('fixture-a') });
    expect(legs.host).toEqual(legs.operation);
  });

  it('只把原因没确认的歌合成一个请求再取', async () => {
    upstream.state.songDetails = { 'fixture-c': REGION_DETAIL };
    const mids = ['fixture-a', 'fixture-b', 'fixture-c', 'fixture-d'];
    const legs = await play(mids.join(','), [
      vkeyReply(mids, ['fixture-a']),
      vkeyReply(['fixture-b', 'fixture-d'], ['fixture-d']),
    ]);
    const vkeys = vkeyCallsOf(legs.operation.calls);
    expect(vkeys.map((rpc) => rpc.param.songmid)).toEqual([mids, ['fixture-b', 'fixture-d']]);
    expect(playUrlOf(legs.operation.body)).toEqual({
      'fixture-a': ok('fixture-a'),
      'fixture-b': failed('playback.reason-unconfirmed'),
      'fixture-c': failed('playback.maybe-region-restricted'),
      'fixture-d': ok('fixture-d'),
    });
    expect(legs.host).toEqual(legs.operation);
  });

  it('再取仍失败：回第一次的结果，不再多要', async () => {
    upstream.state.songDetails = {};
    const legs = await play('fixture-a', [
      vkeyReply(['fixture-a']),
      {
        data: {
          sip: ['https://stream.invalid/'],
          midurlinfo: [{ songmid: 'fixture-a', purl: '', result: 500 }],
        },
      },
      vkeyReply(['fixture-a'], ['fixture-a']),
    ]);
    expect(vkeyCallsOf(legs.operation.calls)).toHaveLength(2);
    expect(playUrlOf(legs.operation.body)).toEqual({
      'fixture-a': failed('playback.reason-unconfirmed'),
    });
  });

  it.each([
    ['上游 503', { httpStatus: 503 }],
    ['业务码 1000', { code: 1000 }],
  ])('再取的请求本身出错（%s）：不影响整体，回第一次的结果', async (_label, reply) => {
    upstream.state.songDetails = {};
    const legs = await play('fixture-a', [vkeyReply(['fixture-a']), reply]);
    expect(legs.operation.status).toBe(200);
    expect(vkeyCallsOf(legs.operation.calls)).toHaveLength(2);
    expect(playUrlOf(legs.operation.body)).toEqual({
      'fixture-a': failed('playback.reason-unconfirmed'),
    });
    expect(legs.host).toEqual(legs.operation);
  });

  it.each([
    ['地区特征', REGION_DETAIL, 'playback.maybe-region-restricted'],
    ['会员特征', MEMBERSHIP_DETAIL, 'playback.maybe-membership'],
  ])('%s已经有具体提示，不再取', async (_label, detail, hint) => {
    upstream.state.songDetails = { 'fixture-a': detail };
    const legs = await play('fixture-a', [vkeyReply(['fixture-a']), vkeyReply(['fixture-a'])]);
    expect(vkeyCallsOf(legs.operation.calls)).toHaveLength(1);
    expect(playUrlOf(legs.operation.body)).toEqual({ 'fixture-a': failed(hint) });
  });

  it('提示关闭时看最终提示：都是原因没确认，照样再取一次', async () => {
    upstream.state.playbackHintsEnabled = false;
    upstream.state.songDetails = { 'fixture-a': REGION_DETAIL };
    const legs = await play('fixture-a', [
      vkeyReply(['fixture-a']),
      vkeyReply(['fixture-a'], ['fixture-a']),
    ]);
    expect(vkeyCallsOf(legs.operation.calls)).toHaveLength(2);
    expect(playUrlOf(legs.operation.body)).toEqual({ 'fixture-a': ok('fixture-a') });
  });

  it.each(['320', 'flac'])('quality=%s 失败不再取', async (quality) => {
    upstream.state.songDetails = {};
    const legs = await play(`fixture-a?quality=${quality}`, [
      vkeyReply(['fixture-a']),
      vkeyReply(['fixture-a'], ['fixture-a']),
    ]);
    expect(vkeyCallsOf(legs.operation.calls)).toHaveLength(1);
    expect(playUrlOf(legs.operation.body)['fixture-a']).toMatchObject({ url: '' });
  });

  it('试听失败不再取', async () => {
    upstream.state.songDetails = {
      'fixture-a': { file: { size_try: 1, media_mid: 'MediaFixtureA1' } },
    };
    const legs = await play('fixture-a?preview=1', [
      vkeyReply(['fixture-a']),
      vkeyReply(['fixture-a'], ['fixture-a']),
    ]);
    expect(vkeyCallsOf(legs.operation.calls)).toHaveLength(1);
    expect(playUrlOf(legs.operation.body)['fixture-a']).toMatchObject({ url: '' });
  });

  it('quality=best 退到最后一级 128 时也再取一次，标 128', async () => {
    upstream.state.songDetails = { 'fixture-a': { file: { size_flac: 1, size_320mp3: 1 } } };
    const legs = await play('fixture-a?quality=best', [
      vkeyReply(['fixture-a']),
      vkeyReply(['fixture-a']),
      vkeyReply(['fixture-a']),
      vkeyReply(['fixture-a'], ['fixture-a']),
    ]);
    const files = vkeyCallsOf(legs.operation.calls).map((rpc) => rpc.param.filename);
    expect(files).toEqual([
      ['F000fixture-afixture-a.flac'],
      ['M800fixture-afixture-a.mp3'],
      ['M500fixture-afixture-a.mp3'],
      ['M500fixture-afixture-a.mp3'],
    ]);
    expect(playUrlOf(legs.operation.body)).toEqual({
      'fixture-a': { ...ok('fixture-a'), quality: '128' },
    });
    expect(legs.host).toEqual(legs.operation);
  });

  if (runtime === 'node')
    it('匿名失败不再取', async () => {
      upstream.state.anonymousPlay = {
        code: 0,
        req_0: {
          code: 0,
          data: {
            sip: ['https://stream.invalid/'],
            midurlinfo: [{ songmid: 'fixture-a', purl: '', result: 104003, subcode: 1 }],
          },
        },
      };
      const legs = await play('fixture-a', [], 'missing');
      expect(vkeyCallsOf(legs.operation.calls)).toHaveLength(1);
      expect(playUrlOf(legs.operation.body)['fixture-a']).toMatchObject({ url: '' });
    });
});
