import type { AxiosRequestConfig, AxiosResponse } from 'axios';
import {
  cookieHeader,
  JSON_CONTENT_TYPE,
  MAX_REDIRECTS,
  mergeCookieHeaders,
  normalizeSetCookies,
  REDIRECT_STATUSES,
  redirectedMethod,
  seedCookieJar,
  updateCookieJar,
} from '../services/auth/cookieJar';
import type { AuthHttpClient } from '../services/auth/httpClient';

/**
 * `AuthHttpClient` over `fetch`. The jar and the redirect rules come from `../services/auth/
 * cookieJar`, so the login protocol behaves identically here and on Node — this file only
 * translates between the axios-shaped config the auth services already speak and a `Request`.
 *
 * 🔴 Redirects are followed by hand (`redirect: 'manual'`) for the same reason the axios client
 * sets `maxRedirects: 0`: the upstream login flow deposits cookies on the redirect hops, and a
 * runtime that follows redirects internally never lets us see those `set-cookie` headers.
 *
 * The `AuthHttpClient` type is imported type-only, so nothing pulls axios into the bundle.
 */

const RESPONSE_TYPES = new Set(['json', 'text', 'arraybuffer']);

/** Every upstream call carries a deadline; see D9. A request with no signal can hang a worker. */
const withDeadline = (signal: AbortSignal | undefined, budgetMs: number): AbortSignal => {
  const deadline = AbortSignal.timeout(budgetMs);
  return signal ? AbortSignal.any([signal, deadline]) : deadline;
};

const headerRecord = (headers: Headers): Record<string, unknown> => {
  const record: Record<string, unknown> = {};
  headers.forEach((value, name) => {
    record[name] = value;
  });
  // `set-cookie` is the one header that legitimately repeats, and a plain record would keep only
  // the last. `getSetCookie()` is what makes the jar see every cookie on a hop.
  const setCookie = headers.getSetCookie?.() ?? [];
  if (setCookie.length > 0) record['set-cookie'] = setCookie;
  return record;
};

const readBody = async (response: Response, responseType: string): Promise<unknown> => {
  if (responseType === 'arraybuffer') return await response.arrayBuffer();
  const text = await response.text();
  if (responseType === 'text') return text;
  // Matching axios: a JSON response type that does not parse yields the raw text rather than
  // throwing, because several upstream endpoints answer with `callback({...})` script text.
  try {
    return text === '' ? '' : JSON.parse(text);
  } catch {
    return text;
  }
};

export const createFetchAuthHttpClient = (
  options: { budgetMs?: number; initialCookies?: string } = {},
): AuthHttpClient => {
  const jar = new Map<string, string>();
  if (options.initialCookies) seedCookieJar(jar, options.initialCookies);
  const defaultBudgetMs = options.budgetMs ?? 10_000;

  const request = async <T>(initial: AxiosRequestConfig): Promise<AxiosResponse<T>> => {
    let config = { ...initial };
    for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
      const configuredHeaders = { ...(config.headers ?? {}) } as Record<string, unknown>;
      const explicitCookieEntry = Object.entries(configuredHeaders).find(
        ([name]) => name.toLowerCase() === 'cookie',
      );
      if (explicitCookieEntry) delete configuredHeaders[explicitCookieEntry[0]];
      const explicitCookies =
        typeof explicitCookieEntry?.[1] === 'string' ? explicitCookieEntry[1] : '';
      const mergedCookies = mergeCookieHeaders(cookieHeader(jar), explicitCookies);

      const responseType = RESPONSE_TYPES.has(String(config.responseType))
        ? String(config.responseType)
        : 'json';
      const method = String(config.method ?? 'GET').toUpperCase();

      const url = new URL(String(config.url));
      for (const [name, value] of Object.entries(config.params ?? {})) {
        if (value !== undefined && value !== null) url.searchParams.set(name, String(value));
      }

      const headers = new Headers();
      if (config.data !== undefined) headers.set('Content-Type', JSON_CONTENT_TYPE);
      for (const [name, value] of Object.entries(configuredHeaders)) {
        if (value !== undefined && value !== null) headers.set(name, String(value));
      }
      if (mergedCookies) headers.set('Cookie', mergedCookies);

      const response = await fetch(url, {
        method,
        headers,
        body:
          config.data === undefined || method === 'GET' || method === 'HEAD'
            ? undefined
            : typeof config.data === 'string'
              ? config.data
              : JSON.stringify(config.data),
        redirect: 'manual',
        signal: withDeadline(config.signal as AbortSignal | undefined, defaultBudgetMs),
      });

      const responseHeaders = headerRecord(response.headers);
      updateCookieJar(jar, normalizeSetCookies(responseHeaders['set-cookie']));

      const location = response.headers.get('location');
      if (!REDIRECT_STATUSES.has(response.status) || !location) {
        // The same window the axios client accepts, so a 4xx surfaces as a rejection either way.
        if (response.status < 200 || response.status >= 400)
          throw new Error(`QQ auth request failed with status ${response.status}`);
        return {
          data: (await readBody(response, responseType)) as T,
          status: response.status,
          statusText: response.statusText,
          headers: responseHeaders,
          config: config as AxiosResponse<T>['config'],
        } as AxiosResponse<T>;
      }
      if (redirectCount === MAX_REDIRECTS) throw new Error('QQ auth redirect limit exceeded');

      const nextMethod = redirectedMethod(response.status, config.method);
      config = {
        ...config,
        url: new URL(location, url).toString(),
        method: nextMethod as AxiosRequestConfig['method'],
        // Params were folded into the URL above; re-applying them would double them on the hop.
        params: undefined,
        data: nextMethod === 'GET' ? undefined : config.data,
      };
    }
    throw new Error('QQ auth redirect limit exceeded');
  };

  return {
    getCookieHeader: () => cookieHeader(jar),
    request,
    post: <T>(url: string, data?: unknown, config: AxiosRequestConfig = {}) =>
      request<T>({ ...config, url, data, method: 'POST' }),
  };
};
