import { AxiosRequestConfig } from 'axios';
import { logger } from '../../util/logger';
import { logServiceFailure, logServiceRequest, logServiceSuccess } from '../../util/observability';
import { dictionaryOf, identifierOf, isDictionary, numberOf } from '../auth/values';
import y_common from '../y_common';
import { type SongListDetailResponse, toSongListDetailResponse } from './officialPlaylist';

interface SongListDetailParams {
  method?: string;
  params?: Record<string, unknown>;
  option?: AxiosRequestConfig;
  /**
   * 匿名 CGI 读不到时（`code: 10`）用登录凭据重读同一张歌单。由各入口在请求带着会话时注入，
   * 解析结果交给 `toSongListDetailResponse`；没有会话就不传，行为与原来完全相同。
   */
  readWithCredential?: (disstid: string) => Promise<unknown>;
}

const upstream = '/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg';
const credentialUpstream = 'music.srfDissInfo.aiDissInfo/uniform_get_Dissinfo';

/** 匿名 CGI 对 QQ 音乐的算法歌单（百万收藏、歌手漫游……）只回这个码，带凭据才读得到。 */
const ANONYMOUS_UNREADABLE_CODE = 10;

/**
 * 重读成功就返回改写后的回应，其余任何情况（没有会话、上游拒绝、读出来是空的）都返回 `null`，
 * 让调用方保留匿名 CGI 的原始回应。这里绝不抛错，也绝不变成 401：这是一条读歌单的路由，
 * 客户端收到 401 会清掉整个登录态。
 */
const readAlgorithmicPlaylist = async (
  disstid: string,
  readWithCredential: NonNullable<SongListDetailParams['readWithCredential']>,
): Promise<SongListDetailResponse | null> => {
  try {
    const adapted = toSongListDetailResponse(await readWithCredential(disstid));
    if (adapted) {
      logServiceSuccess('songListDetail', credentialUpstream, adapted, {
        disstid,
        source: 'credential-fallback',
      });
    }
    return adapted;
  } catch (error) {
    const upstreamCode = numberOf(dictionaryOf(error).upstreamCode);
    logger.warn('service.credential_fallback_failed', {
      service: 'songListDetail',
      disstid,
      name: error instanceof Error ? error.name : 'Error',
      ...(upstreamCode === undefined ? {} : { upstreamCode }),
    });
    return null;
  }
};

export default ({
  method = 'get',
  params = {},
  option = {},
  readWithCredential,
}: SongListDetailParams) => {
  const data = Object.assign(params, {
    format: 'json',
    outCharset: 'utf-8',
    type: 1,
    json: 1,
    utf8: 1,
    onlysong: 0,
    new_format: 1,
  });
  const options = Object.assign(option, {
    params: data,
  });
  logServiceRequest('songListDetail', upstream, data);
  return y_common({
    url: upstream,
    method,
    options,
  })
    .then(async (res: import('axios').AxiosResponse<any>) => {
      const response = res.data;
      logServiceSuccess('songListDetail', upstream, response, {
        disstid: data.disstid,
      });
      const disstid = identifierOf(data.disstid);
      const unreadable =
        isDictionary(response) && numberOf(response.code) === ANONYMOUS_UNREADABLE_CODE;
      const fallback =
        unreadable && disstid && readWithCredential
          ? await readAlgorithmicPlaylist(disstid, readWithCredential)
          : null;
      return {
        status: 200,
        body: {
          response: fallback ?? response,
        },
      };
    })
    .catch((error: unknown) => {
      logServiceFailure('songListDetail', upstream, error, data);
      return {
        status: 500,
        body: {
          error,
        },
      };
    });
};
