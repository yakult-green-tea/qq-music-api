import type Koa from 'koa';
import type { Server } from 'node:http';

/**
 * The package root's public contract, pinned by hand rather than generated.
 *
 * Two reasons it is written out instead of emitted:
 *
 * 1. A whole-`src` declaration emit fails on unexported parameter interfaces in
 *    `src/services/index.ts`. Those are pre-existing upstream defects, and fixing fifteen files to
 *    satisfy a type-emit is outside what this workstream touches.
 * 2. More importantly, this *is* the contract. §5.3 #7 calls the root's export shape Electron's
 *    lifeline; declaring exactly those three exports states the boundary deliberately instead of
 *    publishing every internal type a generated emit would happen to reach.
 *
 * 🔴 Keep in step with `src/app.ts`. `tests/app.composition-root.test.ts` pins the runtime shape;
 * this file pins the compile-time one, and they must describe the same three things.
 */

/** An `AuthSession` as the embedding host sees it. Structural on purpose: hosts only persist it. */
export interface AuthSessionRecord {
  token: string;
  credential: Record<string, unknown>;
  device: Record<string, unknown>;
  expiresAt: number;
}

export interface AuthSessionRepository {
  readonly kind: string;
  load(): unknown;
  save(sessions: readonly AuthSessionRecord[]): void;
}

/**
 * Injects credential persistence. Electron calls this immediately after requiring the package,
 * before the event loop can accept a request.
 */
export declare const configureAuthSessionRepository: (repository: AuthSessionRepository) => void;

/**
 * The HTTP server handle. Requiring the package root starts listening as an import side effect;
 * under a test environment it stays `null`.
 */
export declare const server: Server | null;

declare const app: Koa;
export default app;
