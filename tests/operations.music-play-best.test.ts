import './helpers/sessionRoutes';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import musicPlayOperationController from '../src/controllers/musicPlayOperation';
import { getMusicPlay } from '../src/routes/operations/getMusicPlay';
import { CATALOG_RUNTIMES } from './helpers/catalogRoutes';
import { createParityRunner } from './helpers/operationParity';
import { type SessionCall, useSessionUpstream } from './helpers/sessionRoutes';

// quality=best：带会话时先查详情，用 size_* 跳过没有文件的音质，按 flac → 320 → 128 一级一级要，
// 拿到就停，并在条目上标出实际音质。详情读不到或超过查询上限就直接要 128；匿名也直接要 128。
// 不带 quality 时请求和回应都和以前一样。
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
const vkeyFilesOf = (calls: SessionCall[]) =>
  vkeyCallsOf(calls).map((rpc) => rpc.param.filename as string[]);
const detailLookupsOf = (calls: SessionCall[]) =>
  calls.flatMap((call) => call.rpc).filter((rpc) => rpc.method === 'get_song_detail_yqq');

const sizes = (flac: unknown, mp3320: unknown) => ({
  file: { size_flac: flac, size_320mp3: mp3320, size_128mp3: 4000000 },
});
/** 一次取链接请求的回应：列出的歌拿到链接，其他的 104003／1。 */
const vkeyReply = (mids: string[], granted: string[]) => ({
  data: {
    sip: ['https://stream.invalid/'],
    midurlinfo: mids.map((songmid) =>
      granted.includes(songmid)
        ? { songmid, purl: `${songmid}.audio` }
        : { songmid, purl: '', result: 104003, subcode: 1 },
    ),
  },
});
const ok = (mid: string, quality: string) => ({
  url: `https://stream.invalid/${mid}.audio`,
  error: false,
  source: { kind: 'full', protocol: 'android-vkey', cdn: 'response-sip' },
  quality,
});

it('文档与 Explorer 说明 quality=best', () => {
  const readme = readFileSync(resolve(__dirname, '../docs/README.md'), 'utf8');
  expect(readme).toContain('quality=best');
  const explorer = readFileSync(resolve(__dirname, '../src/config/apiExplorer.ts'), 'utf8');
  expect(explorer).toContain('quality=best');
});

describe.each(CATALOG_RUNTIMES)('/getMusicPlay quality=best（%s）', (runtime) => {
  const upstream = useSessionUpstream(runtime);
  beforeEach(() =>
    jest
      .spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValue('00000000-0000-4000-8000-000000000001'),
  );
  /** 每一轮都重新排好取链接的回应，Node 的两条路径各用一份。 */
  const play = async (
    query: string,
    replies: ReturnType<typeof vkeyReply>[] = [],
    mode: 'valid' | 'missing' = 'valid',
  ) => {
    const options = await upstream.options(mode);
    return parity(runtime, `/getMusicPlay/${query}`, upstream.calls, {
      ...options,
      beforeEachLeg: async () => {
        await options.beforeEachLeg?.();
        upstream.state.rpcReplyQueues = { UrlGetVkey: [...replies] };
      },
    });
  };

  it('有 flac 就先要 flac，拿到就停，标出实际音质', async () => {
    upstream.state.songDetails = { 'fixture-a': sizes(30000000, 9000000) };
    const legs = await play('fixture-a?quality=best', [vkeyReply(['fixture-a'], ['fixture-a'])]);
    expect(legs.operation.status).toBe(200);
    expect(vkeyFilesOf(legs.operation.calls)).toEqual([['F000fixture-afixture-a.flac']]);
    expect(detailLookupsOf(legs.operation.calls)).toHaveLength(1);
    expect(playUrlOf(legs.operation.body)).toEqual({ 'fixture-a': ok('fixture-a', 'flac') });
    expect(legs.host).toEqual(legs.operation);
  });

  it('flac 没拿到就退 320', async () => {
    upstream.state.songDetails = { 'fixture-a': sizes(30000000, 9000000) };
    const legs = await play('fixture-a?quality=best', [
      vkeyReply(['fixture-a'], []),
      vkeyReply(['fixture-a'], ['fixture-a']),
    ]);
    expect(vkeyFilesOf(legs.operation.calls)).toEqual([
      ['F000fixture-afixture-a.flac'],
      ['M800fixture-afixture-a.mp3'],
    ]);
    expect(playUrlOf(legs.operation.body)).toEqual({ 'fixture-a': ok('fixture-a', '320') });
    expect(legs.host).toEqual(legs.operation);
  });

  it.each([
    [0, 0],
    ['0', '0'],
    [-1, null],
  ])('size_flac %j、size_320mp3 %j 没文件就跳过，直接要 128', async (flac, mp3320) => {
    upstream.state.songDetails = { 'fixture-a': sizes(flac, mp3320) };
    const legs = await play('fixture-a?quality=best', [vkeyReply(['fixture-a'], ['fixture-a'])]);
    expect(vkeyFilesOf(legs.operation.calls)).toEqual([['M500fixture-afixture-a.mp3']]);
    expect(playUrlOf(legs.operation.body)).toEqual({ 'fixture-a': ok('fixture-a', '128') });
  });

  it('三级都没拿到：回 128 那一级的结果，也标 128', async () => {
    upstream.state.songDetails = { 'fixture-a': sizes(30000000, 9000000) };
    const legs = await play('fixture-a?quality=best', [
      vkeyReply(['fixture-a'], []),
      vkeyReply(['fixture-a'], []),
      vkeyReply(['fixture-a'], []),
      vkeyReply(['fixture-a'], []),
    ]);
    expect(vkeyFilesOf(legs.operation.calls).slice(0, 3)).toEqual([
      ['F000fixture-afixture-a.flac'],
      ['M800fixture-afixture-a.mp3'],
      ['M500fixture-afixture-a.mp3'],
    ]);
    expect(playUrlOf(legs.operation.body)['fixture-a']).toMatchObject({
      url: '',
      error: '暂无播放链接',
      quality: '128',
      restriction: {
        key: 'url_unavailable',
        codes: { result: 104003, subcode: 1 },
        hint: { key: expect.stringMatching(/^playback\./) },
      },
    });
    expect(legs.host).toEqual(legs.operation);
  });

  it.each([
    'network',
    'business',
    'missing',
  ])('详情读不到（%s）就直接要 128，不猜文件', async (failure) => {
    upstream.state.songDetails = failure === 'missing' ? {} : { 'fixture-a': sizes(1, 1) };
    if (failure === 'network') upstream.state.detailNetworkError = true;
    if (failure === 'business') upstream.state.detailBusinessCode = 1000;
    const legs = await play('fixture-a?quality=best', [vkeyReply(['fixture-a'], ['fixture-a'])]);
    expect(vkeyFilesOf(legs.operation.calls)).toEqual([['M500fixture-afixture-a.mp3']]);
    expect(playUrlOf(legs.operation.body)).toEqual({ 'fixture-a': ok('fixture-a', '128') });
  });

  it('多首歌按音质分批要，各自标出实际音质', async () => {
    upstream.state.songDetails = {
      'fixture-a': sizes(30000000, 9000000),
      'fixture-b': sizes(0, 9000000),
      'fixture-c': sizes(30000000, 0),
    };
    const legs = await play('fixture-a,fixture-b,fixture-c,fixture-d?quality=best', [
      vkeyReply(['fixture-a', 'fixture-c'], ['fixture-a']),
      vkeyReply(['fixture-b'], ['fixture-b']),
      vkeyReply(['fixture-c', 'fixture-d'], ['fixture-c', 'fixture-d']),
    ]);
    const vkeys = vkeyCallsOf(legs.operation.calls);
    expect(vkeys.map((rpc) => rpc.param.songmid)).toEqual([
      ['fixture-a', 'fixture-c'],
      ['fixture-b'],
      ['fixture-c', 'fixture-d'],
    ]);
    expect(playUrlOf(legs.operation.body)).toEqual({
      'fixture-a': ok('fixture-a', 'flac'),
      'fixture-b': ok('fixture-b', '320'),
      'fixture-c': ok('fixture-c', '128'),
      'fixture-d': ok('fixture-d', '128'),
    });
    expect(legs.host).toEqual(legs.operation);
  });

  it('一次最多查 10 首详情，后面的直接要 128', async () => {
    const mids = Array.from({ length: 11 }, (_, index) => `fixture-${index}`);
    upstream.state.songDetails = Object.fromEntries(mids.map((mid) => [mid, sizes(1, 0)]));
    const legs = await play(`${mids.join(',')}?quality=best`, [
      vkeyReply(mids.slice(0, 10), mids.slice(0, 10)),
      vkeyReply(['fixture-10'], ['fixture-10']),
    ]);
    expect(detailLookupsOf(legs.operation.calls)).toHaveLength(10);
    expect(vkeyCallsOf(legs.operation.calls).map((rpc) => rpc.param.songmid)).toEqual([
      mids.slice(0, 10),
      ['fixture-10'],
    ]);
    expect(playUrlOf(legs.operation.body)['fixture-0']).toEqual(ok('fixture-0', 'flac'));
    expect(playUrlOf(legs.operation.body)['fixture-10']).toEqual(ok('fixture-10', '128'));
  });

  it('preview=1 优先试听，不走 best、不标音质', async () => {
    upstream.state.songDetails = {
      'fixture-a': { file: { size_try: 1, media_mid: 'MediaFixtureA1', size_flac: 1 } },
    };
    upstream.state.data = {
      sip: ['https://stream.invalid/'],
      midurlinfo: [{ songmid: 'fixture-a', purl: 'fixture.mp3' }],
    };
    const legs = await play('fixture-a?quality=best&preview=1');
    expect(vkeyFilesOf(legs.operation.calls)).toEqual([['RS02MediaFixtureA1.mp3']]);
    expect(playUrlOf(legs.operation.body)['fixture-a']).not.toHaveProperty('quality');
  });

  it.each(['', '?quality=128', '?quality=flac'])('%s 不标音质，和以前一样', async (query) => {
    upstream.state.data = {
      sip: ['https://stream.invalid/'],
      midurlinfo: [{ songmid: 'fixture-a', purl: 'fixture.mp3' }],
    };
    const legs = await play(`fixture-a${query}`);
    expect(detailLookupsOf(legs.operation.calls)).toEqual([]);
    expect(playUrlOf(legs.operation.body)).toEqual({
      'fixture-a': {
        url: 'https://stream.invalid/fixture.mp3',
        error: false,
        source: { kind: 'full', protocol: 'android-vkey', cdn: 'response-sip' },
      },
    });
  });

  if (runtime === 'node')
    it('匿名的 best 直接要 128、不查详情，条目标 128', async () => {
      upstream.state.songDetails = { 'fixture-a': sizes(30000000, 9000000) };
      const legs = await play('fixture-a,fixture-b?quality=best', [], 'missing');
      expect(detailLookupsOf(legs.operation.calls)).toEqual([]);
      expect(vkeyFilesOf(legs.operation.calls)).toEqual([
        ['M500fixture-afixture-a.mp3', 'M500fixture-bfixture-b.mp3'],
      ]);
      expect(playUrlOf(legs.operation.body)).toEqual({
        'fixture-a': { url: 'https://stream.invalid/fixture.mp3', error: false, quality: '128' },
        'fixture-b': { url: 'https://stream.invalid/fixture.mp3', error: false, quality: '128' },
      });
      expect(legs.host).toEqual(legs.operation);
    });
});
