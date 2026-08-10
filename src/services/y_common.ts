import { AxiosRequestConfig } from 'axios';
import { BaseYCommonParams } from '../types/core/request';
import { logger } from '../util/logger';
import { getLegacyHttpTransport } from './httpTransport';

export default ({
  url,
  method = 'get',
  options = {},
  hasCommonParams = true,
}: BaseYCommonParams) => {
  // See `u_common.ts`: defaults come from the registered transport, never from `../config`.
  const transport = getLegacyHttpTransport();
  const commonParams = hasCommonParams ? transport.defaults.commonParams : {};
  const opts: AxiosRequestConfig = Object.assign({}, options, commonParams, {
    headers: {
      referer: transport.defaults.referer.c,
      host: 'c.y.qq.com',
      ...options.headers,
    },
  });
  logger.debug(url, { opts });
  return transport.request(url, method, opts);
};
