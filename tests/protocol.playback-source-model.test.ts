import { CLIENT_COMM_OF } from '../src/protocol/clientProfiles';
import { playbackFileOfPurl } from '../src/protocol/playbackFiles';
import {
  PLAYBACK_PROTOCOLS,
  type PlaybackSource,
  playbackAccessOf,
  playbackPlayabilityOf,
  publicSourceOf,
} from '../src/protocol/playbackSource';

// 音源描述补齐的部分：文件种类只从上游真的给的文件名认，认不出就不填；授权结果和能不能直接播分开记；
// 试听只交上游宣告的长度，片段起止没有可靠来源前不填（不默认 0）。

describe('从上游给的文件名认出文件种类', () => {
  it.each([
    ['C400fixtureSongMidA1FixtureMedia01.m4a?guid=g&vkey=v&uin=0', 'm4a', 'm4a'],
    ['M500fixtureSongMidA1FixtureMedia01.mp3?guid=g&vkey=v', '128', 'mp3'],
    ['M800fixtureSongMidA1FixtureMedia01.mp3', '320', 'mp3'],
    ['F000fixtureSongMidA1FixtureMedia01.flac?vkey=v', 'flac', 'flac'],
    ['A000fixtureSongMidA1FixtureMedia01.ape', 'ape', 'ape'],
    ['RS02FixtureMedia01.mp3?vkey=v', 'preview', 'mp3'],
  ] as const)('%s → %s／%s，没有加密', (purl, quality, codec) => {
    expect(playbackFileOfPurl(purl)).toEqual({ quality, codec, encryption: 'none' });
  });

  it.each([
    'a.audio',
    '',
    'M500fixtureSongMidA1.flac',
    'O4M0fixtureSongMidA1FixtureMedia01.mgg',
    'X999fixture.mp3',
    'M500.mp3',
    'dir/M500fixtureSongMidA1.mp3/../evil',
  ])('认不出的 %p 不填，也不猜', (purl) => {
    expect(playbackFileOfPurl(purl)).toBeUndefined();
  });
});

describe('授权结果和能不能直接播分开记', () => {
  const base = {
    granted: true,
    kind: 'full',
    cdn: 'response-sip',
    encryption: 'none',
  } as const;
  it.each([
    [{ ...base }, 'full', 'direct'],
    [{ ...base, kind: 'preview' }, 'preview', 'direct'],
    [{ ...base, kind: 'unknown' }, 'unknown', 'direct'],
    [{ ...base, cdn: 'unverified-default' }, 'full', 'cdn-unverified'],
    [{ ...base, encryption: undefined }, 'full', 'direct'],
    [{ ...base, granted: false, cdn: 'none' }, 'refused', 'unplayable'],
  ] as const)('%o → %s／%s', (source, access, playability) => {
    expect(playbackAccessOf(source)).toBe(access);
    expect(playbackPlayabilityOf(source)).toBe(playability);
  });

  it('加密文件不是能直接播的格式', () => {
    expect(playbackPlayabilityOf({ ...base, encryption: 'encrypted' })).toBe(
      'unsupported-encrypted',
    );
  });
});

describe('取链接的办法和客户端身份', () => {
  it('EVKey 明文只登记，加密文件只在独立路由使用', () => {
    expect(PLAYBACK_PROTOCOLS['evkey-plain']).toMatchObject({
      rpc: 'music.vkey.GetEVkey/CgiGetEVkey',
      implemented: false,
      usedByDefault: false,
      evidence: 'observed-response',
      files: 'plain',
    });
    expect(PLAYBACK_PROTOCOLS['encrypted-evkey']).toMatchObject({
      rpc: 'music.vkey.GetEVkey/CgiGetEVkey',
      implemented: true,
      usedByDefault: false,
      evidence: 'verified-controlled',
      files: 'encrypted',
      qualities: ['96', '192', 'flac'],
    });
  });

  it('每种身份实际送的 ct／cv 记在一处，和协议常数一致', () => {
    expect(CLIENT_COMM_OF).toEqual({
      android: { ct: 11, cv: 14090008 },
      web: { ct: 24, cv: 0 },
      webPlayer: { ct: 24, cv: 4747474 },
      lite: { ct: 11, cv: '1003006' },
    });
  });
});

describe('对外的 source', () => {
  const source: PlaybackSource = {
    songmid: 'fixtureSongMidA1',
    kind: 'preview',
    requestedQuality: '128',
    attemptedQuality: 'preview',
    protocol: 'preview-rs02',
    deviceProfile: 'android',
    client: { ct: 11, cv: 14090008 },
    url: 'https://stream.invalid/RS02FixtureMedia01.mp3',
    granted: true,
    cdn: 'response-sip',
    audioVerified: false,
    codes: {},
    deliveredQuality: 'preview',
    codec: 'mp3',
    encryption: 'none',
    access: 'preview',
    playability: 'direct',
    declaredDurationMs: 184000,
    trial: { durationMs: 60000, durationSource: 'upstream-declared', rangeSource: 'unknown' },
  };

  it('只多交实际音质、格式和试听长度；内部的其他栏位不交', () => {
    expect(publicSourceOf(source)).toEqual({
      kind: 'preview',
      protocol: 'preview-rs02',
      cdn: 'response-sip',
      quality: 'preview',
      codec: 'mp3',
      trial: { durationMs: 60000 },
    });
  });

  it('不知道的就不交：没认出文件、没有试听长度时和以前一样只有三个栏位', () => {
    const {
      deliveredQuality: _quality,
      codec: _codec,
      encryption: _encryption,
      trial: _trial,
      ...unknown
    } = source;
    expect(publicSourceOf(unknown)).toEqual({
      kind: 'preview',
      protocol: 'preview-rs02',
      cdn: 'response-sip',
    });
  });

  it('试听片段起止就算内部有值也不交（3.3.7 先不填）', () => {
    const withRange: PlaybackSource = {
      ...source,
      trial: {
        durationMs: 60000,
        durationSource: 'upstream-declared',
        startMs: 0,
        endMs: 60000,
        rangeSource: 'measured',
      },
    };
    expect(publicSourceOf(withRange).trial).toEqual({ durationMs: 60000 });
  });
});
