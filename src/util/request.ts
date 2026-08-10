import axios, { AxiosRequestConfig, AxiosResponse, Method, ResponseType } from 'axios';
import { apiConfig, requestConfig } from '../config';
import type { LegacyHttpTransport } from '../services/httpTransport';
import { logger } from './logger';
import { summarizeValue } from './observability';

// Keep the legacy QQ request defaults on a package-private client. This module is also
// loaded when the npm package is embedded in a larger Electron or Node process, where the
// top-level axios module is shared with unrelated SDKs. Mutating `axios.defaults` here would
// therefore make those SDKs' request serialization depend on module import order.
const qqMusicHttpClient = axios.create({
  withCredentials: requestConfig.withCredentials,
  timeout: requestConfig.timeout,
  responseType: requestConfig.responseType as ResponseType,
});

// Preserve the existing legacy behavior for POST requests without leaking it to the host.
qqMusicHttpClient.defaults.headers.post['Content-Type'] = requestConfig.contentType;

function request<T = unknown>(
  url: string,
  method: string,
  options: AxiosRequestConfig = {},
  isUUrl = 'c',
): Promise<AxiosResponse<T>> {
  let baseURL = '';
  switch (isUUrl) {
    case 'y':
      baseURL = requestConfig.baseURL.y + url;
      break;
    case 'u':
      baseURL = url;
      break;
    case 'c':
      baseURL = requestConfig.baseURL.c + url;
      break;
    default:
      baseURL = requestConfig.baseURL.c + url;
      break;
  }

  const axiosMethod = method.toLowerCase() as Method;
  const requestConfigOptions: AxiosRequestConfig = {
    ...options,
    url: baseURL,
    method: axiosMethod,
  };

  logger.debug('upstream.requesting', {
    scope: 'request',
    url: baseURL,
    method: axiosMethod,
    params: summarizeValue(options.params),
  });

  return qqMusicHttpClient(requestConfigOptions).then(
    (response: AxiosResponse<T>) => {
      if (!response) {
        throw Error('response is null');
      }
      logger.debug('upstream.succeeded', {
        scope: 'request',
        url: baseURL,
        method: axiosMethod,
        status: response.status,
        result: summarizeValue(response.data),
      });
      return response;
    },
    (error: unknown) => {
      logger.error('upstream.failed', {
        scope: 'request',
        url: baseURL,
        method: axiosMethod,
        error: summarizeValue(error),
      });
      throw error;
    },
  );
}

/**
 * The Node composition root's legacy transport: the package-private axios client above, plus the
 * request defaults the catalog services used to read straight from `src/config`.
 *
 * The defaults are getters rather than a snapshot so a host that reconfigures the package after
 * import keeps observing the same values it does today.
 */
export const createAxiosLegacyTransport = (): LegacyHttpTransport => ({
  kind: 'axios',
  defaults: {
    get baseURL() {
      return {
        y: requestConfig.baseURL.y,
        c: requestConfig.baseURL.c,
        u: requestConfig.baseURL.u,
      };
    },
    get referer() {
      return {
        y: requestConfig.referer.y,
        c: requestConfig.referer.c,
        u: requestConfig.referer.u,
      };
    },
    get commonParams() {
      return apiConfig.commonParams;
    },
  },
  request,
});

export default request;
