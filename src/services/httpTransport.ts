import type { AxiosRequestConfig, AxiosResponse } from 'axios';

// Composition-root seam for the legacy catalog HTTP path.
//
// This module holds a module-local registration slot and nothing else. It must never import a
// runtime module: `src/serverless` bundles it, and the M0 spike proved that a single value import
// here would drag `axios`, `colors` and the filesystem-backed config manager into that bundle.
// The `axios` imports below are type-only and are erased before any bundler sees this file.
//
// The seam owns request *defaults* as well as request execution. Reading them from `src/config`
// inside the catalog services is what pulls `config/manager.ts` — and therefore `node:fs` — into
// the serverless dependency graph, so each transport supplies the defaults its runtime can serve.

/** `y` and `c` are prefixed with their base URL; `u` is already an absolute musicu URL. */
export type LegacyRequestTarget = 'y' | 'c' | 'u';

export interface LegacyRequestDefaults {
  readonly baseURL: Readonly<Record<LegacyRequestTarget, string>>;
  readonly referer: Readonly<Record<LegacyRequestTarget, string>>;
  readonly commonParams: Readonly<Record<string, unknown>>;
}

/**
 * The response stays axios-shaped because every catalog service already annotates its `.then`
 * callback with `AxiosResponse`. A non-axios runtime adapts into this shape instead, which keeps
 * the seam free of the 33-file annotation churn a narrower response type would have required.
 */
export interface LegacyHttpTransport {
  /** Diagnostic label only; never used for branching. */
  readonly kind: string;
  readonly defaults: LegacyRequestDefaults;
  request<T = unknown>(
    url: string,
    method: string,
    options?: AxiosRequestConfig,
    target?: string,
  ): Promise<AxiosResponse<T>>;
}

const MISSING_TRANSPORT_MESSAGE =
  'Legacy QQ HTTP transport is not registered. Register one in the composition root before ' +
  'calling a catalog service: Node, Electron and Docker load `src/app.ts`, which calls ' +
  '`setLegacyHttpTransport(createAxiosLegacyTransport())`; the serverless runtime registers its ' +
  'fetch transport from `src/serverless`. Tests register the axios transport in `tests/setup.ts`.';

let registered: LegacyHttpTransport | null = null;

export const setLegacyHttpTransport = (transport: LegacyHttpTransport): void => {
  registered = transport;
};

export const getLegacyHttpTransport = (): LegacyHttpTransport => {
  if (!registered) throw new Error(MISSING_TRANSPORT_MESSAGE);
  return registered;
};

/** Test hook: restores the unregistered state so the failure message stays covered. */
export const clearLegacyHttpTransport = (): void => {
  registered = null;
};
