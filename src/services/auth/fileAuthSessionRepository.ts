import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../../util/logger';
import type { AuthSessionRepository } from './qrLogin';
import { configureAuthSessionRepository } from './qrLogin.node';
import { AUTH_SESSION_STORE_PURPOSE, openJson, sealJson } from './sessionCrypto';

// Encrypted at-rest persistence for the server-side login state. Without it a Docker or bare
// Node deployment loses every login on restart, because the packaged default repository is
// process-local memory and only Electron ships an implementation of its own.
//
// The file holds complete credentials, so it is written owner-only and never leaves the server.
// It is opt-in: a deployment that sets neither variable behaves exactly as it does today.

export const AUTH_SESSION_PATH_ENV = 'QQ_AUTH_SESSION_PATH';
export const SESSION_SECRET_ENV = 'QQ_SESSION_SECRET';

const STATE_FILE_MODE = 0o600;

/**
 * Writes through a temporary file in the same directory and renames it into place. Two reasons,
 * both of which cost a real login if skipped: `mode` is only applied when a file is created, so
 * an existing loosely-permissioned file would silently keep its mode; and a crash midway through
 * a plain overwrite would leave a half-written envelope that fails authentication on restart.
 */
const writeAtomically = (filePath: string, contents: string): void => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, contents, { encoding: 'utf8', mode: STATE_FILE_MODE });
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    fs.rmSync(temporaryPath, { force: true });
    throw error;
  }
};

/**
 * Failures are thrown, not swallowed. The login service already treats a repository as untrusted
 * and degrades to in-process behaviour on either side, so throwing keeps a corrupt file or a
 * rotated secret visible in the logs instead of quietly looking like an empty store.
 */
export const createFileAuthSessionRepository = (
  filePath: string,
  secret: string,
): AuthSessionRepository => ({
  kind: 'file',
  load: () => {
    // A missing file is the first run, not a failure.
    if (!fs.existsSync(filePath)) return [];
    return openJson(fs.readFileSync(filePath, 'utf8'), secret, AUTH_SESSION_STORE_PURPOSE);
  },
  save: (sessions) => {
    writeAtomically(filePath, sealJson(sessions, secret, AUTH_SESSION_STORE_PURPOSE));
  },
});

export const resolveAuthSessionPath = (env: NodeJS.ProcessEnv = process.env): string | null => {
  const configured = env[AUTH_SESSION_PATH_ENV]?.trim();
  return configured ? path.resolve(configured) : null;
};

/**
 * Explicit opt-in, never a silent downgrade. Both variables present enables persistence; neither
 * present is today's behaviour; exactly one present is a misconfiguration that gets one clear
 * warning and keeps running on memory. The secret is never generated on our side — an invented
 * key would be regenerated on the next restart and produce a file nothing can ever read again.
 */
export const createConfiguredAuthSessionRepository = (
  env: NodeJS.ProcessEnv = process.env,
): AuthSessionRepository | null => {
  const filePath = resolveAuthSessionPath(env);
  const secret = env[SESSION_SECRET_ENV]?.trim();
  if (!filePath && !secret) return null;
  if (!filePath || !secret) {
    logger.warn('qq-auth.auth-session.persistence-incomplete', {
      pathVariable: AUTH_SESSION_PATH_ENV,
      secretVariable: SESSION_SECRET_ENV,
      hasPath: Boolean(filePath),
      hasSecret: Boolean(secret),
    });
    return null;
  }
  return createFileAuthSessionRepository(filePath, secret);
};

/**
 * Composition-root entry point: the only thing `src/app.ts` calls. An embedding host that injects
 * its own repository through `configureAuthSessionRepository` is unaffected, because a host that
 * does so does not set these variables.
 */
export const configureAuthSessionPersistence = (
  env: NodeJS.ProcessEnv = process.env,
): AuthSessionRepository | null => {
  const repository = createConfiguredAuthSessionRepository(env);
  if (repository) configureAuthSessionRepository(repository);
  return repository;
};
