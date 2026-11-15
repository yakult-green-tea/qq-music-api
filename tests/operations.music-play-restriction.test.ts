import './helpers/sessionRoutes';
import musicPlayOperationController from '../src/controllers/musicPlayOperation';
import { getMusicPlay } from '../src/routes/operations/getMusicPlay';
import { logger } from '../src/util/logger';
import { CATALOG_RUNTIMES } from './helpers/catalogRoutes';
import { createParityRunner } from './helpers/operationParity';
import { type SessionCall, useSessionUpstream } from './helpers/sessionRoutes';

// 取不到链接的那首歌多一个可选的 restriction：没有受控证据之前一律是 url_unavailable，
// codes 只收单曲条目里的安全整数。拿到链接的那首一个字都不变。
const parity = createParityRunner(
  { name: 'getMusicPlay', node: '/getMusicPlay/:songmid?', serverless: '/getMusicPlay/:songmid?' },
  {
    operation: getMusicPlay,
    operationNode: musicPlayOperationController,
  },
);
const uuid = '00000000-0000-4000-8000-000000000001';
/** 原因没有验证过的规则可用时，不为挑提示多查单曲详情。 */
const methodsOf = (calls: SessionCall[]) =>
  calls.flatMap((call) => call.rpc.map((rpc) => rpc.method));

const MIXED_ENTRIES = [
  { songmid: 'fixture-a', purl: 'fixture.mp3', result: 0 },
  {
    songmid: 'fixture-b',
    purl: '',
    result: 104003,
    subcode: '1',
    errtype: '',
    vkey: 'fixture-private-vkey',
    tips: 'fixture-private-tip',
  },
  { songmid: 'fixture-c', purl: '', result: 1.5, code: 2 ** 60, subcode: 'abc' },
];

const EXPECTED_PLAY_URL = {
  'fixture-a': { url: 'https://stream.invalid/fixture.mp3', error: false },
  'fixture-b': {
    url: '',
    error: '暂无播放链接',
    restriction: {
      key: 'url_unavailable',
      evidence: 'observed-response',
      codes: { result: 104003, subcode: 1 },
      hint: { key: 'playback.reason-unconfirmed', message: expect.any(String) },
    },
  },
  'fixture-c': {
    url: '',
    error: '暂无播放链接',
    restriction: {
      key: 'url_unavailable',
      evidence: 'observed-response',
      hint: { key: 'playback.reason-unconfirmed', message: expect.any(String) },
    },
  },
};

/** 带会话时每条从上游来的结果多一个 source；匿名路径没有。 */
const EXPECTED_SESSION_PLAY_URL = {
  'fixture-a': {
    ...EXPECTED_PLAY_URL['fixture-a'],
    source: { kind: 'full', protocol: 'android-vkey', cdn: 'response-sip' },
  },
  'fixture-b': {
    ...EXPECTED_PLAY_URL['fixture-b'],
    source: { kind: 'full', protocol: 'android-vkey', cdn: 'none' },
  },
  'fixture-c': {
    ...EXPECTED_PLAY_URL['fixture-c'],
    source: { kind: 'full', protocol: 'android-vkey', cdn: 'none' },
  },
};

describe.each(CATALOG_RUNTIMES)('/getMusicPlay 的 restriction（%s）', (runtime) => {
  const upstream = useSessionUpstream(runtime);
  beforeEach(() => jest.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(uuid));

  it('带会话：没链接的歌附上 restriction，有链接的歌不变', async () => {
    upstream.state.data = { sip: ['https://stream.invalid/'], midurlinfo: MIXED_ENTRIES };
    const legs = await parity(
      runtime,
      '/getMusicPlay/fixture-a,fixture-b,fixture-c',
      upstream.calls,
      await upstream.options(),
    );
    expect(legs.operation.status).toBe(200);
    expect(legs.operation.body).toEqual({ data: { playUrl: EXPECTED_SESSION_PLAY_URL } });
    expect(JSON.stringify(legs.operation.body)).not.toContain('fixture-private');
    expect(legs.host).toEqual(legs.operation);
    expect(
      methodsOf(upstream.calls).filter((method) => method === 'get_song_detail_yqq'),
    ).toHaveLength(1);
  });

  it('带会话：全部拿到链接时没有任何 restriction', async () => {
    upstream.state.data = {
      sip: ['https://stream.invalid/'],
      midurlinfo: [{ songmid: 'fixture-a', purl: 'fixture.mp3' }],
    };
    const legs = await parity(
      runtime,
      '/getMusicPlay/fixture-a',
      upstream.calls,
      await upstream.options(),
    );
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
    it('匿名：没链接的歌同样附上 restriction', async () => {
      upstream.state.anonymousPlay = {
        code: 0,
        req_0: { code: 0, data: { sip: ['https://stream.invalid/'], midurlinfo: MIXED_ENTRIES } },
      };
      const legs = await parity(
        runtime,
        '/getMusicPlay/fixture-a,fixture-b,fixture-c',
        upstream.calls,
        await upstream.options('missing'),
      );
      expect(legs.operation.status).toBe(200);
      expect(legs.operation.body).toEqual({ data: { playUrl: EXPECTED_PLAY_URL } });
      expect(legs.host).toEqual(legs.operation);
      expect(methodsOf(upstream.calls)).not.toContain('get_song_detail_yqq');
    });

    it('匿名 resType=raw：整份上游回应照旧，只有 playUrl 多了 restriction', async () => {
      const anonymousPlay = {
        code: 0,
        req_0: { code: 0, data: { sip: ['https://stream.invalid/'], midurlinfo: MIXED_ENTRIES } },
      };
      upstream.state.anonymousPlay = anonymousPlay;
      const legs = await parity(
        runtime,
        '/getMusicPlay/fixture-a,fixture-b,fixture-c?resType=raw',
        upstream.calls,
        await upstream.options('missing'),
      );
      expect(legs.operation.body).toEqual({
        data: { ...anonymousPlay, playUrl: EXPECTED_PLAY_URL },
      });
    });

    it('匿名：没链接的歌各记一条开发日志，只带位置、音质和安全整数', async () => {
      const debug = jest.spyOn(logger, 'debug').mockImplementation(() => undefined);
      upstream.state.anonymousPlay = {
        code: 0,
        req_0: { code: 0, data: { sip: ['https://stream.invalid/'], midurlinfo: MIXED_ENTRIES } },
      };
      await parity(
        runtime,
        '/getMusicPlay/fixture-a,fixture-b,fixture-c?quality=320',
        upstream.calls,
        await upstream.options('missing'),
      );
      const events = debug.mock.calls
        .filter(([event]) => event === 'playback.url-unavailable')
        .map(([, meta]) => meta);
      // 两条腿（共用处理和真实宿主）各打一次。
      expect(events).toEqual(
        Array(2)
          .fill([
            {
              phase: 'get-music-play-anonymous',
              index: 1,
              quality: '320',
              entryCodes: { result: 104003, subcode: 1 },
            },
            { phase: 'get-music-play-anonymous', index: 2, quality: '320', entryCodes: {} },
          ])
          .flat(),
      );
      expect(JSON.stringify(events)).not.toMatch(/fixture-[abc]|fixture-private/);
    });
  }
});
