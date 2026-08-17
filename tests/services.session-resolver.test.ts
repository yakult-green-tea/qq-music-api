import { createAndroidDevice } from '../src/services/auth/deviceContext';
import type { AuthSession, AuthSessionRepository } from '../src/services/auth/qrLogin';
import {
  createMemoryAuthSessionRepository,
  createStoredSessionResolver,
} from '../src/services/auth/qrLogin';

// The `stored` half of the `SessionResolver` port. It is deliberately a thin adapter over the
// existing `AuthSessionStore`, so what is worth asserting here is the adaptation itself — token
// minting, the async surface, and the two lifecycle hooks — not the storage semantics, which
// `services.qr-login.test.ts` and `services.file-auth-session-repository.test.ts` already own.

const sessionInput = (expiresAt: number): Omit<AuthSession, 'token'> => ({
  credential: { musicid: '42', musickey: 'must-not-leak', loginType: 2 },
  device: createAndroidDevice(),
  expiresAt,
});

const createResolver = (
  options: { repository?: AuthSessionRepository; now?: () => number } = {},
) => {
  let counter = 0;
  return createStoredSessionResolver({
    repository: options.repository ?? createMemoryAuthSessionRepository(),
    now: options.now ?? Date.now,
    // Deterministic tokens keep the assertions readable; the shape still matches the real one.
    randomBytes: (size) => Buffer.alloc(size, ++counter),
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
});
