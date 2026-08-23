import { createAndroidDevice } from '../src/services/auth/deviceContext';
import type { AuthSession, AuthSessionRepository } from '../src/services/auth/qrLogin';
import {
  createMemoryAuthSessionRepository,
  createStoredSessionResolver,
} from '../src/services/auth/qrLogin';

// The `stored` half of the `SessionResolver` port. The existing AuthSessionStore still owns storage
// semantics; this suite pins the resolver concerns around it: opaque tokens, lifecycle hooks and
// the stored-only silent-refresh boundary.

const sessionInput = (
  expiresAt: number,
  credential: Partial<AuthSession['credential']> = {},
): Omit<AuthSession, 'token'> => ({
  credential: { musicid: '42', musickey: 'must-not-leak', loginType: 2, ...credential },
  device: createAndroidDevice(),
  expiresAt,
});

const createResolver = (
  options: {
    repository?: AuthSessionRepository;
    now?: () => number;
    refreshCredential?: (session: AuthSession) => Promise<AuthSession['credential']>;
  } = {},
) => {
  let counter = 0;
  return createStoredSessionResolver({
    repository: options.repository ?? createMemoryAuthSessionRepository(),
    now: options.now ?? Date.now,
    // Deterministic tokens keep the assertions readable; the shape still matches the real one.
    randomBytes: (size) => Buffer.alloc(size, ++counter),
    refreshCredential: options.refreshCredential,
  });
};

describe('createStoredSessionResolver', () => {
  it('should declare the stored mode', () => {
    expect(createResolver().mode).toBe('stored');
  });

  it('should mint a token and resolve it back to the issued session', async () => {
    const resolver = createResolver();
    const expiresAt = Date.now() + 60_000;

    const token = await resolver.issue(sessionInput(expiresAt));
    const resolved = await resolver.resolve(token);

    expect(resolved).toMatchObject({ token, expiresAt });
    expect(resolved?.credential.musickey).toBe('must-not-leak');
  });

  it('should keep minting the 64-character hex token shape callers already store', async () => {
    // Folia writes the token to localStorage verbatim and never parses it, but a silent change of
    // shape here would still be a change to the wire contract, so it is pinned.
    const token = await createResolver().issue(sessionInput(Date.now() + 60_000));

    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('should answer null for a missing, unknown or expired token', async () => {
    const now = Date.now();
    const resolver = createResolver({ now: () => now });
    const token = await resolver.issue(sessionInput(now - 1));

    expect(await resolver.resolve(undefined)).toBeNull();
    expect(await resolver.resolve('')).toBeNull();
    expect(await resolver.resolve('a'.repeat(64))).toBeNull();
    // Expired records are pruned by `cleanup`, which the service calls before every lookup.
    resolver.cleanup?.();
    expect(await resolver.resolve(token)).toBeNull();
  });

  it('should revoke precisely, leaving every other session logged in', async () => {
    // The behavioural difference from `sealed` that the port exists to make explicit: under
    // `stored`, logout deletes exactly one session and nothing else.
    const resolver = createResolver();
    const first = await resolver.issue(sessionInput(Date.now() + 60_000));
    const second = await resolver.issue(sessionInput(Date.now() + 60_000));

    await resolver.revoke(first);

    expect(await resolver.resolve(first)).toBeNull();
    expect(await resolver.resolve(second)).not.toBeNull();
  });

  it('should write issued sessions through to the repository', async () => {
    const saved: AuthSession[][] = [];
    const repository: AuthSessionRepository = {
      kind: 'probe',
      load: () => [],
      save: (sessions) => {
        saved.push(sessions.map((session) => ({ ...session })));
      },
    };

    const token = await createResolver({ repository }).issue(sessionInput(Date.now() + 60_000));

    expect(saved.at(-1)?.map((session) => session.token)).toEqual([token]);
  });

  it('should carry live sessions across a repository swap', async () => {
    // Electron's lifeline: the package starts serving on require, and the host injects its
    // encrypted repository immediately afterwards. A session issued in between must survive.
    const resolver = createResolver();
    const token = await resolver.issue(sessionInput(Date.now() + 60_000));

    resolver.useRepository?.(createMemoryAuthSessionRepository());

    expect(await resolver.resolve(token)).not.toBeNull();
  });

  it('should restore the sessions a swapped-in repository already holds', async () => {
    const resolver = createResolver();
    const restored: AuthSession = {
      token: 'b'.repeat(64),
      ...sessionInput(Date.now() + 60_000),
    };

    resolver.useRepository?.(createMemoryAuthSessionRepository([restored]));

    expect(await resolver.resolve(restored.token)).toMatchObject({ token: restored.token });
  });

  it('should refresh inside the six-hour window without changing the opaque token', async () => {
    let current = 1_000_000_000_000;
    const repository = createMemoryAuthSessionRepository();
    const refreshCredential = jest.fn(async () => ({
      musicid: '42',
      musickey: 'refreshed-key',
      loginType: 2,
      refresh_key: 'next-refresh-key',
      musickeyCreateTime: Math.floor(current / 1000),
      keyExpiresIn: 259200,
    }));
    const resolver = createResolver({ repository, now: () => current, refreshCredential });
    const token = await resolver.issue(
      sessionInput(current + 12 * 60 * 60 * 1000, {
        refresh_key: 'refresh-key',
        musickeyCreateTime: Math.floor(current / 1000),
        keyExpiresIn: 12 * 60 * 60,
      }),
    );

    expect((await resolver.resolve(token))?.credential.musickey).toBe('must-not-leak');
    expect(refreshCredential).not.toHaveBeenCalled();

    current += 6 * 60 * 60 * 1000 + 1;
    const refreshed = await resolver.resolve(token);

    expect(refreshCredential).toHaveBeenCalledTimes(1);
    expect(refreshed).toMatchObject({
      token,
      credential: { musickey: 'refreshed-key' },
      expiresAt: (Math.floor(current / 1000) + 259200) * 1000,
    });
    expect((repository.load() as AuthSession[])[0]).toMatchObject({
      token,
      credential: { musickey: 'refreshed-key' },
    });
  });

  it('should not refresh credentials that carry no refresh key', async () => {
    const current = 1_000_000_000_000;
    const refreshCredential = jest.fn();
    const resolver = createResolver({ now: () => current, refreshCredential });
    const token = await resolver.issue(
      sessionInput(current + 60_000, {
        musickeyCreateTime: Math.floor(current / 1000) - 259199,
        keyExpiresIn: 259200,
      }),
    );

    await expect(resolver.resolve(token)).resolves.toMatchObject({ token });
    expect(refreshCredential).not.toHaveBeenCalled();
  });

  it('should share one in-flight refresh across concurrent resolves', async () => {
    const current = 1_000_000_000_000;
    let finishRefresh: ((credential: AuthSession['credential']) => void) | undefined;
    const refreshCredential = jest.fn(
      () =>
        new Promise<AuthSession['credential']>((resolve) => {
          finishRefresh = resolve;
        }),
    );
    const resolver = createResolver({ now: () => current, refreshCredential });
    const token = await resolver.issue(
      sessionInput(current + 60_000, {
        refresh_key: 'refresh-key',
        musickeyCreateTime: Math.floor(current / 1000) - 259199,
        keyExpiresIn: 259200,
      }),
    );

    const first = resolver.resolve(token);
    const second = resolver.resolve(token);
    expect(refreshCredential).toHaveBeenCalledTimes(1);
    finishRefresh?.({
      musicid: '42',
      musickey: 'refreshed-key',
      loginType: 2,
      musickeyCreateTime: Math.floor(current / 1000),
      keyExpiresIn: 259200,
    });

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({
        token,
        credential: expect.objectContaining({ musickey: 'refreshed-key' }),
      }),
      expect.objectContaining({
        token,
        credential: expect.objectContaining({ musickey: 'refreshed-key' }),
      }),
    ]);
  });

  it('should keep the still-live credential and throttle retries after refresh failure', async () => {
    let current = 1_000_000_000_000;
    const refreshCredential = jest.fn(async () => {
      throw new Error('temporary upstream failure');
    });
    const resolver = createResolver({ now: () => current, refreshCredential });
    const token = await resolver.issue(
      sessionInput(current + 60_000, {
        refresh_key: 'refresh-key',
        musickeyCreateTime: Math.floor(current / 1000) - 259199,
        keyExpiresIn: 259200,
      }),
    );

    await expect(resolver.resolve(token)).resolves.toMatchObject({
      token,
      credential: { musickey: 'must-not-leak' },
    });
    await resolver.resolve(token);
    expect(refreshCredential).toHaveBeenCalledTimes(1);

    current += 5 * 60 * 1000 + 1;
    await resolver.resolve(token);
    expect(refreshCredential).toHaveBeenCalledTimes(2);
  });

  it('should not resurrect a token revoked while its refresh is in flight', async () => {
    const current = 1_000_000_000_000;
    let finishRefresh: ((credential: AuthSession['credential']) => void) | undefined;
    const resolver = createResolver({
      now: () => current,
      refreshCredential: () =>
        new Promise<AuthSession['credential']>((resolve) => {
          finishRefresh = resolve;
        }),
    });
    const token = await resolver.issue(
      sessionInput(current + 60_000, {
        refresh_key: 'refresh-key',
        musickeyCreateTime: Math.floor(current / 1000) - 259199,
        keyExpiresIn: 259200,
      }),
    );

    const resolving = resolver.resolve(token);
    await resolver.revoke(token);
    finishRefresh?.({ musicid: '42', musickey: 'refreshed-key', loginType: 2 });

    await expect(resolving).resolves.toBeNull();
    await expect(resolver.resolve(token)).resolves.toBeNull();
  });
});
