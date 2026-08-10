import { AxiosRequestConfig } from 'axios';
import { BaseUCommonParams } from '../types/core/request';
import { logger } from '../util/logger';
import { getLegacyHttpTransport } from './httpTransport';

export default ({ options = {}, method = 'get' }: BaseUCommonParams) => {
  // The registered transport owns both execution and the request defaults. Reading them from
  // `../config` here is what pulled the filesystem-backed config manager into the serverless
  // dependency graph (M0 0.2).
  const transport = getLegacyHttpTransport();
  const { baseURL, commonParams, referer } = transport.defaults;
  const opts: AxiosRequestConfig = Object.assign({}, options, commonParams, {
    headers: {
      referer: referer.u,
      host: 'u.y.qq.com',
      'content-type': 'application/x-www-form-urlencoded',
      ...options.headers,
    },
  });
  logger.debug(baseURL.u, { opts });
  return transport.request(baseURL.u, method, opts, 'u');
};
