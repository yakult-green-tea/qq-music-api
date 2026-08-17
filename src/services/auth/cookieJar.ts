/**
 * The cookie jar and redirect rules the QQ auth protocol needs, kept apart from any one HTTP
 * client so both the axios client and the serverless fetch client share exactly one implementation.
 *
 * Moved here verbatim from `httpClient.ts`. Nothing in this file may import a value from `axios`
 * or anything reaching `node:fs`: it is bundled into the serverless runtime, where the dependency
 * closure test asserts neither appears.
 *
 * Why a hand-written jar at all: the upstream login flow spreads its state across `set-cookie`
 * headers on redirect hops, and the platforms this package targets do not agree on cookie handling
 * — Node's axios has no jar, and `fetch` deliberately refuses to expose `set-cookie` on redirects
 * it follows itself. Owning the jar is what makes the protocol behave identically on both.
 */

export const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
export const MAX_REDIRECTS = 3;
export const JSON_CONTENT_TYPE = 'application/json';

export const normalizeSetCookies = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  return typeof value === 'string' ? [value] : [];
};

export const updateCookieJar = (jar: Map<string, string>, setCookies: string[]): void => {
  for (const setCookie of setCookies) {
    const pair = setCookie.split(';', 1)[0];
    const separator = pair.indexOf('=');
    if (separator <= 0) continue;
    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (value) jar.set(name, value);
    else jar.delete(name);
  }
};

export const cookieHeader = (jar: Map<string, string>): string =>
  Array.from(jar, ([name, value]) => `${name}=${value}`).join('; ');

export const mergeCookieHeaders = (...headers: string[]): string => {
  const merged = new Map<string, string>();
  for (const header of headers) {
    for (const item of header.split(';')) {
      const separator = item.indexOf('=');
      const name = item.slice(0, separator).trim();
      const value = item.slice(separator + 1).trim();
      if (name) merged.set(name, value);
    }
  }
  return cookieHeader(merged);
};

/** 303 always becomes GET; 301/302 downgrade POST to GET. 307/308 preserve the method. */
export const redirectedMethod = (status: number, method: string | undefined): string => {
  if (status === 303) return 'GET';
  if ([301, 302].includes(status) && String(method).toUpperCase() === 'POST') return 'GET';
  return method ?? 'GET';
};
