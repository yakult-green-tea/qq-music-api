// Value coercions shared by the auth protocol modules. Upstream answers are untrusted JSON, so
// every field is read through one of these instead of being asserted into a type.
//
// This module is runtime-neutral on purpose: it must stay importable from a serverless bundle,
// so it may never gain a Node-only dependency.

export type Dictionary = Record<string, unknown>;

export const isDictionary = (value: unknown): value is Dictionary =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const dictionaryOf = (value: unknown): Dictionary => (isDictionary(value) ? value : {});

export const stringOf = (value: unknown): string => (typeof value === 'string' ? value : '');

export const identifierOf = (value: unknown): string =>
  typeof value === 'string' || typeof value === 'number' ? String(value) : '';

export const numberOf = (value: unknown): number | undefined => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

/**
 * Recognises an aborted request across both transports: axios reports `CanceledError` /
 * `ERR_CANCELED`, `fetch` reports `AbortError`, and `AbortSignal.timeout` reports `TimeoutError`.
 */
export const isAbortError = (error: unknown): boolean => {
  if (!isDictionary(error) && !(error instanceof Error)) return false;
  const candidate = error as { name?: unknown; code?: unknown };
  return (
    candidate.name === 'AbortError' ||
    candidate.name === 'TimeoutError' ||
    candidate.name === 'CanceledError' ||
    candidate.code === 'ERR_CANCELED' ||
    candidate.code === 'ABORT_ERR'
  );
};

export const parseDictionary = (value: unknown): Dictionary => {
  if (isDictionary(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    return dictionaryOf(JSON.parse(value));
  } catch {
    return {};
  }
};
