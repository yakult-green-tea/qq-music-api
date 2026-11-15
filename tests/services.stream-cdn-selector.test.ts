import { StreamCdnSelector, type StreamUrlProbe } from '../src/services/auth/streamCdnSelector';

describe('StreamCdnSelector', () => {
  it('selects the fastest compatible dispatched CDN and ignores untrusted hosts', async () => {
    const probe = jest.fn<ReturnType<StreamUrlProbe>, Parameters<StreamUrlProbe>>(async (url) => {
      if (url.startsWith('https://fast.stream.qqmusic.qq.com/'))
        return { bytes: 262_144, elapsedMs: 100 };
      if (url.startsWith('http://dl.stream.qqmusic.qq.com/'))
        return { bytes: 262_144, elapsedMs: 1_000 };
      return null;
    });
    const selector = new StreamCdnSelector(probe);

    await expect(
      selector.select(
        [
          'https://attacker.example/',
          'http://dl.stream.qqmusic.qq.com/',
          'https://fast.stream.qqmusic.qq.com/',
        ],
        'F000fixture.flac?vkey=signed',
      ),
    ).resolves.toBe('https://fast.stream.qqmusic.qq.com/');
    expect(probe).toHaveBeenCalledTimes(2);
    expect(probe).not.toHaveBeenCalledWith(expect.stringContaining('attacker.example'));
  });

  it('caches a selection until the dispatch refresh interval expires', async () => {
    let now = 1_000;
    const probe = jest.fn(async () => ({ bytes: 262_144, elapsedMs: 100 }));
    const selector = new StreamCdnSelector(probe, () => now);
    const candidates = ['https://fast.stream.qqmusic.qq.com/'];

    await selector.select(candidates, 'first.flac?vkey=one', 60_000);
    await selector.select(candidates, 'second.flac?vkey=two', 60_000);
    expect(probe).toHaveBeenCalledTimes(1);

    now += 60_001;
    await selector.select(candidates, 'third.flac?vkey=three', 60_000);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('returns null when no dispatched CDN accepts the signed URL', async () => {
    const selector = new StreamCdnSelector(async () => null);

    await expect(
      selector.select(['https://ws.stream.qqmusic.qq.com/'], 'fixture.flac?vkey=signed'),
    ).resolves.toBeNull();
  });

  it('keeps concurrent selections for different candidate sets apart', async () => {
    const release: Array<() => void> = [];
    const probe = jest.fn<ReturnType<StreamUrlProbe>, Parameters<StreamUrlProbe>>(
      (url) =>
        new Promise((resolve) => {
          release.push(() =>
            resolve(url.includes('second.stream') ? null : { bytes: 1024, elapsedMs: 10 }),
          );
        }),
    );
    const selector = new StreamCdnSelector(probe);

    const first = selector.select(['https://first.stream.qqmusic.qq.com/'], 'a.mp3?vkey=one');
    const second = selector.select(['https://second.stream.qqmusic.qq.com/'], 'b.mp3?vkey=two');
    for (const done of release) done();

    await expect(first).resolves.toBe('https://first.stream.qqmusic.qq.com/');
    await expect(second).resolves.toBeNull();
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('shares one in-flight measurement between concurrent selections of the same candidates', async () => {
    const probe = jest.fn(async () => ({ bytes: 1024, elapsedMs: 10 }));
    const selector = new StreamCdnSelector(probe);
    const candidates = ['https://fast.stream.qqmusic.qq.com/'];

    const results = await Promise.all([
      selector.select(candidates, 'a.mp3?vkey=one'),
      selector.select(candidates, 'b.mp3?vkey=two'),
    ]);

    expect(results).toEqual([candidates[0], candidates[0]]);
    expect(probe).toHaveBeenCalledTimes(1);
  });
});
