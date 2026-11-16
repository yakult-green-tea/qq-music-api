import {
  CONTRACT_CREDENTIAL,
  type Reply,
  type Runtime,
  setupSessionRoute,
  sharedSessionReadCases,
} from './helpers/newSessionRoute';

// 相似歌曲接歌（`AutoPlayServer.GetRadioSimilarSongs`）：要登录。官方 App 只送 1 首种子、amount 3、from 4，
// 两个账号实测都回 3 首完整曲目和一个标题。和 `/song/similar`、`/recommend/autoplay` 是不同的上游。

const track = (id: number) => ({
  id,
  mid: `fixture-similar-autoplay-${id}`,
  name: `Fixture similar autoplay ${id}`,
  file: { media_mid: `fixture-media-${id}` },
});
const row = (value: unknown) => ({ track: value });
const SIMILAR = {
  vecSong: [row(track(7101)), row(track(7102)), row(track(7103))],
  recTitle: 'fixture-title',
  ext: {},
};
const defaults = (): Record<string, Reply> => ({ GetRadioSimilarSongs: { data: SIMILAR } });

describe.each(['node', 'serverless'] as Runtime[])('similar autoplay route: %s', (runtime) => {
  const ctx = setupSessionRoute(runtime, defaults);
  sharedSessionReadCases(
    runtime,
    ctx,
    '/recommend/autoplay/similar?id=801',
    'GetRadioSimilarSongs',
  );

  it.each([
    '/recommend/autoplay/similar',
    '/recommend/autoplay/similar?id=',
    '/recommend/autoplay/similar?id=abc',
    '/recommend/autoplay/similar?id=0',
    '/recommend/autoplay/similar?id=801,802',
    '/recommend/autoplay/similar?id=801&id=802',
  ])('%s answers 400 without reaching the upstream', async (path) => {
    const result = await ctx.call(path, { token: ctx.token });

    expect(result.status).toBe(400);
    expect(result.body.errorKey).toBe('input.invalid');
    expect(ctx.recorded).toEqual([]);
  });

  it('asks with one seed like the official app and returns the tracks only', async () => {
    const result = await ctx.call('/recommend/autoplay/similar?id=801', { token: ctx.token });

    expect(result.status).toBe(200);
    expect(result.headers['cache-control']).toBe('private, no-store');
    expect(result.body).toEqual({ code: 200, songs: [track(7101), track(7102), track(7103)] });
    expect(ctx.recorded).toHaveLength(1);
    expect(ctx.recorded[0].rpcs).toEqual([
      {
        module: 'music.recommend.AutoPlayServer',
        method: 'GetRadioSimilarSongs',
        param: { vecSong: [801], amount: 3, from: 4 },
      },
    ]);
    expect(ctx.recorded[0].comm).toMatchObject({ ct: 11, authst: CONTRACT_CREDENTIAL.musickey });
    expect(JSON.stringify(result.body)).not.toContain('fixture-title');
  });

  it.each([
    ['an empty list', { vecSong: [] }],
    ['null', { vecSong: null }],
  ])('no similar song (%s) is a normal empty list', async (_label, data) => {
    ctx.replies.GetRadioSimilarSongs = { data };

    const result = await ctx.call('/recommend/autoplay/similar?id=801', { token: ctx.token });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ code: 200, songs: [] });
  });

  it.each([
    ['a non-list', { vecSong: {} }],
    ['nothing readable', { vecSong: [row(null)] }],
    ['a non-object payload', 'x'],
  ])('answers 502 for %s instead of an empty list', async (_label, data) => {
    ctx.replies.GetRadioSimilarSongs = { data };

    const result = await ctx.call('/recommend/autoplay/similar?id=801', { token: ctx.token });

    expect(result.status).toBe(502);
    expect(result.body.errorKey).toBe('upstream.invalid-response');
  });

  it('a non-zero retcode inside the data is an upstream failure', async () => {
    ctx.replies.GetRadioSimilarSongs = { data: { retcode: 2001, vecSong: [] } };

    const result = await ctx.call('/recommend/autoplay/similar?id=801', { token: ctx.token });

    expect(result.status).toBe(502);
    expect(result.body).toMatchObject({ errorKey: 'upstream.unknown', upstreamCode: 2001 });
  });
});
