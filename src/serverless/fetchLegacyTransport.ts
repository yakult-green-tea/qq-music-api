import type { AxiosRequestConfig, AxiosResponse } from 'axios';
import type { LegacyHttpTransport, LegacyRequestDefaults } from '../services/httpTransport';

/**
 * The legacy catalog transport over `fetch`, filling the seam S1 opened.
 *
 * 🔴 The defaults are inlined rather than read from `src/config`. That is the whole point of the
 * seam carrying `defaults`: the catalog services used to read the config barrel directly, and that
 * barrel reaches `config/manager.ts` and therefore `node:fs`, which cannot be bundled for a Worker.
 * The values below mirror `config/default.ts`; a serverless deployment does not have the config
 * file that would let a user override them, so the defaults are the whole story here.
 *
 * The response is adapted into an `AxiosResponse` shape because all 33 catalog services annotate
 * their `.then` callbacks with it. Keeping the shape is what let S1 open this seam without touching
 * any of them.
 */

const DEFAULTS: LegacyRequestDefaults = {
  baseURL: {
    y: 'https://y.qq.com',
    c: 'https://c.y.qq.com',
    u: 'https://u.y.qq.com/cgi-bin/musicu.fcg',
  },
  referer: {
    y: 'https://y.qq.com/',
    c: 'https://c.y.qq.com/',
    u: 'https://y.qq.com/portal/player.html',
  },
  commonParams: {
    g_tk: 1124214810,
    loginUin: '0',
    hostUin: 0,
    inCharset: 'utf8',
    outCharset: 'utf-8',
    notice: 0,
    platform: 'yqq.json',
    needNewCode: 0,
  },
};

const withDeadline = (signal: AbortSignal | undefined, budgetMs: number): AbortSignal => {
  const deadline = AbortSignal.timeout(budgetMs);
  return signal ? AbortSignal.any([signal, deadline]) : deadline;
};

const resolveUrl = (url: string, target: string): string => {
  if (/^https?:\/\//.test(url)) return url;
  // `u` is already an absolute musicu URL in the seam's contract; `y` and `c` get their base.
  if (target === 'u') return DEFAULTS.baseURL.u;
  const base = target === 'c' ? DEFAULTS.baseURL.c : DEFAULTS.baseURL.y;
  return `${base}${url.startsWith('/') ? '' : '/'}${url}`;
};

const refererFor = (target: string): string =>
  target === 'c' ? DEFAULTS.referer.c : target === 'u' ? DEFAULTS.referer.u : DEFAULTS.referer.y;

export const createFetchLegacyTransport = (
  options: { budgetMs?: number } = {},
): LegacyHttpTransport => {
  const defaultBudgetMs = options.budgetMs ?? 10_000;

  return {
    kind: 'fetch',
    defaults: DEFAULTS,
    request: async <T = unknown>(
      url: string,
      method: string,
      config: AxiosRequestConfig = {},
      // Matches `request()` in `util/request.ts`: an omitted target is the catalog default,
      // `c.y.qq.com`. `y_common` (despite its name) never passes a target at all, so getting this
      // wrong sends every one of its calls to the wrong host — see the regression test below.
      target = 'c',
    ): Promise<AxiosResponse<T>> => {
      const resolved = new URL(resolveUrl(url, target));
      for (const [name, value] of Object.entries(config.params ?? {})) {
        if (value !== undefined && value !== null) resolved.searchParams.set(name, String(value));
      }

      const headers = new Headers({ Referer: refererFor(target) });
      for (const [name, value] of Object.entries(
        (config.headers ?? {}) as Record<string, unknown>,
      )) {
        if (value !== undefined && value !== null) headers.set(name, String(value));
      }

      const upper = method.toUpperCase();
      const response = await fetch(resolved, {
        method: upper,
        headers,
        body:
          config.data === undefined || upper === 'GET' || upper === 'HEAD'
            ? undefined
            : typeof config.data === 'string'
              ? config.data
              : JSON.stringify(config.data),
        signal: withDeadline(config.signal as AbortSignal | undefined, defaultBudgetMs),
      });

      const text = await response.text();
      let data: unknown = text;
      // The catalog endpoints answer with JSON, and several wrap it in a JSONP callback. Parsing
      // leniently keeps the axios behaviour the services were written against.
      try {
        data = text === '' ? '' : JSON.parse(text);
      } catch {
        data = text;
      }

      const responseHeaders: Record<string, unknown> = {};
      response.headers.forEach((value, name) => {
        responseHeaders[name] = value;
      });

      return {
        data: data as T,
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
        config: config as AxiosResponse<T>['config'],
      } as AxiosResponse<T>;
    },
  };
};
