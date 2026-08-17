import axios, { type AxiosInstance, type AxiosRequestConfig, type AxiosResponse } from 'axios';
import {
  cookieHeader,
  JSON_CONTENT_TYPE,
  MAX_REDIRECTS,
  mergeCookieHeaders,
  normalizeSetCookies,
  REDIRECT_STATUSES,
  redirectedMethod,
  updateCookieJar,
} from './cookieJar';

// The jar, the redirect rules and their constants moved to `./cookieJar` unchanged, so the
// serverless fetch client can share them without importing axios. Behaviour here is untouched.

export interface AuthHttpClient {
  getCookieHeader(): string;
  request<T>(config: AxiosRequestConfig): Promise<AxiosResponse<T>>;
  post<T>(url: string, data?: unknown, config?: AxiosRequestConfig): Promise<AxiosResponse<T>>;
}

export const createAuthHttpClient = (
  transport: AxiosInstance = axios.create({ timeout: 25000, maxRedirects: 0 }),
): AuthHttpClient => {
  const jar = new Map<string, string>();

  const request = async <T>(initial: AxiosRequestConfig): Promise<AxiosResponse<T>> => {
    let config = { ...initial };
    for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
      const cookies = cookieHeader(jar);
      const configuredHeaders = { ...(config.headers ?? {}) } as Record<string, unknown>;
      const explicitCookieEntry = Object.entries(configuredHeaders).find(
        ([name]) => name.toLowerCase() === 'cookie',
      );
      if (explicitCookieEntry) delete configuredHeaders[explicitCookieEntry[0]];
      const explicitCookies =
        typeof explicitCookieEntry?.[1] === 'string' ? explicitCookieEntry[1] : '';
      const mergedCookies = mergeCookieHeaders(cookies, explicitCookies);
      // Keep the auth protocol independent from host-level axios defaults. This package can
      // be embedded in a larger Electron or Node process where another dependency may change
      // the shared axios singleton before this client is created, so JSON semantics are pinned
      // per request instead of depending on host import order.
      const response = await transport.request<T>({
        ...config,
        headers: {
          ...(config.data === undefined ? {} : { 'Content-Type': JSON_CONTENT_TYPE }),
          ...configuredHeaders,
          ...(mergedCookies ? { Cookie: mergedCookies } : {}),
        },
        // The web login channels answer with HTML, `window.wx_errcode=...` / `ptuiCB('...')`
        // script text and raw QR images, so a caller may opt into `text` / `arraybuffer`
        // explicitly. Anything that does not ask stays JSON: this must never fall back to the
        // host's global axios default, which is outside this package's control.
        responseType: config.responseType ?? 'json',
        maxRedirects: 0,
        validateStatus: (status) => status >= 200 && status < 400,
      });
      updateCookieJar(jar, normalizeSetCookies(response.headers['set-cookie']));

      const location = response.headers.location;
      if (!REDIRECT_STATUSES.has(response.status) || !location) return response;
      if (redirectCount === MAX_REDIRECTS) throw new Error('QQ auth redirect limit exceeded');

      const method = redirectedMethod(response.status, config.method);
      config = {
        ...config,
        url: new URL(location, config.url).toString(),
        method,
        data: method === 'GET' ? undefined : config.data,
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

export default createAuthHttpClient;
