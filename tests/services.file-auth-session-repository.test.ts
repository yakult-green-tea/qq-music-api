import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAndroidDevice } from '../src/services/auth/deviceContext';
import {
  AUTH_SESSION_PATH_ENV,
  createConfiguredAuthSessionRepository,
  createFileAuthSessionRepository,
  resolveAuthSessionPath,
  SESSION_SECRET_ENV,
} from '../src/services/auth/fileAuthSessionRepository';
import type { AuthSession } from '../src/services/auth/qrLogin';
import { SessionCryptoError } from '../src/services/auth/sessionCrypto';
import { logger } from '../src/util/logger';

const SECRET = 'a-deployment-secret';

const withTempDir = <T>(run: (directory: string) => T): T => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-auth-session-'));
  try {
    return run(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
};

const sessionFixture = (token: string, expiresAt = Date.now() + 60_000): AuthSession => ({
  token,
  credential: { musicid: '123', musickey: 'must-not-leak', loginType: 2 },
  device: createAndroidDevice(),
  expiresAt,
});

/**
 * Windows reports a synthetic 0o666 / 0o444 from the read-only attribute and has no POSIX mode to
 * check, so the owner-only assertion can only run where it is actually enforced. The deployments
 * this file exists for — Docker and bare Node — are on that side.
 */
const expectOwnerOnly = (filePath: string): void => {
  if (process.platform === 'win32') return;
  expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
};

describe('encrypted file auth session repository', () => {
  it('should round-trip sessions through an encrypted file', () => {
    withTempDir((directory) => {
      const filePath = path.join(directory, 'nested', 'qq-auth-sessions.json');
      const repository = createFileAuthSessionRepository(filePath, SECRET);
      const sessions = [sessionFixture('token-one'), sessionFixture('token-two')];

      repository.save(sessions);

      expect(repository.kind).toBe('file');
      expect(repository.load()).toEqual(sessions);
    });
  });

  it('should keep credentials out of the file and off the wider filesystem', () => {
    withTempDir((directory) => {
      const filePath = path.join(directory, 'qq-auth-sessions.json');
      createFileAuthSessionRepository(filePath, SECRET).save([sessionFixture('token-one')]);
      const contents = fs.readFileSync(filePath, 'utf8');

      expect(contents).not.toContain('must-not-leak');
      expect(contents).not.toContain('token-one');
      // Owner-only. The file holds complete credentials, so group or world readability is a leak.
      expectOwnerOnly(filePath);
      // The atomic write must not leave its temporary file behind.
      expect(fs.readdirSync(directory)).toEqual(['qq-auth-sessions.json']);
    });
  });

  it('should treat a missing file as an empty first run', () => {
    withTempDir((directory) => {
      const repository = createFileAuthSessionRepository(
        path.join(directory, 'never-written.json'),
        SECRET,
      );

      expect(repository.load()).toEqual([]);
    });
  });

  it('should refuse a tampered file and a rotated secret rather than return partial state', () => {
    withTempDir((directory) => {
      const filePath = path.join(directory, 'qq-auth-sessions.json');
      createFileAuthSessionRepository(filePath, SECRET).save([sessionFixture('token-one')]);

      expect(() => createFileAuthSessionRepository(filePath, 'other-secret').load()).toThrow(
        SessionCryptoError,
      );

      fs.writeFileSync(filePath, 'not an envelope', 'utf8');
      expect(() => createFileAuthSessionRepository(filePath, SECRET).load()).toThrow(
        SessionCryptoError,
      );
    });
  });

  it('should overwrite an existing file in place instead of accumulating state', () => {
    withTempDir((directory) => {
      const filePath = path.join(directory, 'qq-auth-sessions.json');
      const repository = createFileAuthSessionRepository(filePath, SECRET);
      const replacement = sessionFixture('token-two');

      repository.save([sessionFixture('token-one')]);
      repository.save([replacement]);

      expect(repository.load()).toEqual([replacement]);
      expect(fs.readdirSync(directory)).toEqual(['qq-auth-sessions.json']);
      expectOwnerOnly(filePath);
    });
  });
});

describe('auth session persistence configuration', () => {
  const warn = jest.spyOn(logger, 'warn');

  beforeEach(() => {
    warn.mockImplementation(() => undefined);
    warn.mockClear();
  });

  afterAll(() => {
    warn.mockRestore();
  });

  it('should stay on the packaged default when neither variable is set', () => {
    expect(createConfiguredAuthSessionRepository({})).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it('should enable the file repository only when both variables are set', () => {
    withTempDir((directory) => {
      const repository = createConfiguredAuthSessionRepository({
        [AUTH_SESSION_PATH_ENV]: path.join(directory, 'sessions.json'),
        [SESSION_SECRET_ENV]: SECRET,
      });

      expect(repository?.kind).toBe('file');
      expect(warn).not.toHaveBeenCalled();
    });
  });

  it('should warn once and keep memory behaviour when only one variable is set', () => {
    // Explicit opt-in, never a silent downgrade: half a configuration is a mistake worth saying
    // out loud, but not worth refusing to start over.
    expect(
      createConfiguredAuthSessionRepository({ [AUTH_SESSION_PATH_ENV]: '/tmp/sessions.json' }),
    ).toBeNull();
    expect(createConfiguredAuthSessionRepository({ [SESSION_SECRET_ENV]: SECRET })).toBeNull();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenNthCalledWith(
      1,
      'qq-auth.auth-session.persistence-incomplete',
      expect.objectContaining({ hasPath: true, hasSecret: false }),
    );
  });

  it('should ignore whitespace-only values and resolve the path against the process directory', () => {
    expect(
      createConfiguredAuthSessionRepository({
        [AUTH_SESSION_PATH_ENV]: '   ',
        [SESSION_SECRET_ENV]: '  ',
      }),
    ).toBeNull();
    expect(resolveAuthSessionPath({ [AUTH_SESSION_PATH_ENV]: 'state/sessions.json' })).toBe(
      path.resolve('state/sessions.json'),
    );
    expect(resolveAuthSessionPath({})).toBeNull();
  });
});

// The restart and degradation behaviour is exercised against the real login service in
// `services.qr-login.test.ts`, where the protocol harness already models a process restart.
