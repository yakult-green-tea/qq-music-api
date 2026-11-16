import {
  CONTRACT_CREDENTIAL,
  type Reply,
  type Runtime,
  setupSessionRoute,
  sharedSessionReadCases,
} from './helpers/newSessionRoute';

const PATH = '/user/business-card';
const METHOD = 'GetMusicBusinessCard';
const CARD = {
  User: {
    EncUin: 'fixture-private-user',
    Nick: 'Fixture listener',
    Headurl: 'https://y.gtimg.cn/fixture-avatar.png',
    Tags: [{ Name: 'Fixture tag', Icon: '', type: 0 }],
    Iden: 2,
  },
  MusicTags: [{ Name: 'Fixture music tag', Icon: '', type: 1 }],
  FavoriteSongs: [
    {
      id: '123456789',
      mainText: 'Fixture song',
      descText: 'Fixture subtitle',
      picURL: 'https://y.gtimg.cn/fixture-cover.png',
    },
  ],
  Ext: { GuideDesc: 'fixture-private-guide', QRCodeURL: 'https://y.qq.com/fixture-private-qr' },
};

const defaults = (): Record<string, Reply> => ({ [METHOD]: { data: CARD } });

describe.each(['node', 'serverless'] as Runtime[])('music business card route: %s', (runtime) => {
  const ctx = setupSessionRoute(runtime, defaults);
  sharedSessionReadCases(runtime, ctx, PATH, METHOD);

  it('reads the current account once with Android and returns only the card fields', async () => {
    const result = await ctx.call(`${PATH}?EncUin=fixture-other-account`, { token: ctx.token });

    expect(result.status).toBe(200);
    expect(result.headers['cache-control']).toBe('private, no-store');
    expect(result.body).toEqual({
      code: 200,
      nick: CARD.User.Nick,
      avatar: CARD.User.Headurl,
      tags: [{ name: 'Fixture tag', icon: '', type: 0 }],
      musicTags: [{ name: 'Fixture music tag', icon: '', type: 1 }],
      favoriteSongs: [
        {
          id: '123456789',
          title: 'Fixture song',
          subtitle: 'Fixture subtitle',
          cover: 'https://y.gtimg.cn/fixture-cover.png',
        },
      ],
    });
    expect(ctx.recorded).toHaveLength(1);
    expect(ctx.recorded[0].comm).toMatchObject({ ct: 11, authst: CONTRACT_CREDENTIAL.musickey });
    expect(ctx.recorded[0].rpcs).toEqual([
      {
        module: 'music.homepage.HomepageShareSvr',
        method: METHOD,
        param: { EncUin: CONTRACT_CREDENTIAL.encryptUin },
      },
    ]);
  });

  it('returns empty lists for a card with no tags or favorite songs', async () => {
    ctx.replies[METHOD] = { data: { User: { Nick: 'Fixture listener' }, MusicTags: [] } };

    const result = await ctx.call(PATH, { token: ctx.token });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      code: 200,
      nick: 'Fixture listener',
      avatar: '',
      tags: [],
      musicTags: [],
      favoriteSongs: [],
    });
  });

  it('keeps an upstream error inside the card payload', async () => {
    ctx.replies[METHOD] = { data: { ...CARD, retcode: 500031 } };

    const result = await ctx.call(PATH, { token: ctx.token });

    expect(result.status).toBe(502);
    expect(result.body).toMatchObject({ errorKey: 'upstream.unknown', upstreamCode: 500031 });
  });

  it.each([
    ['missing profile', { FavoriteSongs: [] }],
    ['invalid tags', { ...CARD, MusicTags: 'bad' }],
    ['favorite songs without IDs', { ...CARD, FavoriteSongs: [{ mainText: 'x' }] }],
  ])('answers 502 for %s', async (_label, data) => {
    ctx.replies[METHOD] = { data };

    const result = await ctx.call(PATH, { token: ctx.token });

    expect(result.status).toBe(502);
    expect(result.body.errorKey).toBe('upstream.invalid-response');
  });
});
