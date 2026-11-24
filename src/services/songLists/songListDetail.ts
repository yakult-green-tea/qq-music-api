import type { HttpClientResponse, HttpRequestConfig } from '../../transport/httpClientTypes';
import { logger } from '../../util/logger';
import { logServiceFailure, logServiceRequest, logServiceSuccess } from '../../util/observability';
import { toLegacyErrorBody } from '../../util/safeError';
import { dictionaryOf, identifierOf, isDictionary, numberOf } from '../../util/values';
import y_common from '../y_common';
import { type SongListDetailResponse, toSongListDetailResponse } from './officialPlaylist';
import { readPublicSongListDetail } from './publicPlaylist';

export interface SongListDetailParams {
  method?: string;
  params?: Record<string, unknown>;
  option?: HttpRequestConfig;
  /**
   * 匿名 CGI 读不到时（`code: 10`）用登录凭据重读同一张歌单。由各入口在请求带着会话时注入，
   * 解析结果交给 `toSongListDetailResponse`；没有会话就不传，行为与原来完全相同。
   */
  readWithCredential?: (disstid: string) => Promise<unknown>;
  /**
   * 旧 CGI 回 `subcode 4000` 时匿名改读公开歌单。默认用匿名 musicu（`publicPlaylist.ts`），测试可以注入。
   */
  readPublicPlaylist?: (disstid: string) => Promise<SongListDetailResponse | null>;
}

const upstream = '/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg';
const credentialUpstream = 'music.srfDissInfo.aiDissInfo/uniform_get_Dissinfo';

/** 匿名 CGI 对 QQ 音乐的算法歌单（百万收藏、歌手漫游……）只回这个码，带凭据才读得到。 */
const ANONYMOUS_UNREADABLE_CODE = 10;

/**
 * 中国大陆出口的旧 CGI 对部分公开歌单回 `code 0`、`subcode 4000`（`check privacy error!`），没有歌单
 * 内容；海外出口正常（2026-11 对照实测）。同一张歌单用匿名 musicu 读得到。
 */
const PRIVACY_REJECTED_SUBCODE = 4000;

/** 回应里有一张带标题的歌单，就不算被拒：判据与 Folia 读这条路由时一样，看 `cdlist[0].dissname`。 */
const hasReadablePlaylist = (response: Record<string, unknown>): boolean => {
  const first = Array.isArray(response.cdlist) ? dictionaryOf(response.cdlist[0]) : {};
  return typeof first.dissname === 'string' && first.dissname.trim() !== '';
};

const isPrivacyRejected = (response: unknown): boolean =>
  isDictionary(response) &&
  numberOf(response.code) === 0 &&
  numberOf(response.subcode) === PRIVACY_REJECTED_SUBCODE &&
  !hasReadablePlaylist(response);

const publicUpstream = 'music.srfDissInfo.aiDissInfo/uniform_get_Dissinfo#anonymous';

/** 匿名改读：读到就返回改写后的回应，其余情况（读不到、上游拒绝、连不上）都返回 `null`，绝不抛错。 */
const readPublicPlaylist = async (
  disstid: string,
  read: NonNullable<SongListDetailParams['readPublicPlaylist']>,
): Promise<SongListDetailResponse | null> => {
  try {
    const adapted = await read(disstid);
    if (adapted) {
      logServiceSuccess('songListDetail', publicUpstream, adapted, {
        disstid,
        source: 'public-fallback',
      });
    }
    return adapted;
  } catch (error) {
    const upstreamCode = numberOf(dictionaryOf(error).upstreamCode);
    logger.warn('service.public_fallback_failed', {
      service: 'songListDetail',
      disstid,
      name: error instanceof Error ? error.name : 'Error',
      ...(upstreamCode === undefined ? {} : { upstreamCode }),
    });
    return null;
  }
};

/**
 * 重读成功就返回改写后的回应，其余任何情况（没有会话、上游拒绝、读出来是空的）都返回 `null`，
 * 让调用方保留匿名 CGI 的原始回应。这里绝不抛错，也绝不变成 401：这是一条读歌单的路由，
 * 客户端收到 401 会清掉整个登录态。
 */
const readAlgorithmicPlaylist = async (
  disstid: string,
  readWithCredential: NonNullable<SongListDetailParams['readWithCredential']>,
  adaptOptions: Parameters<typeof toSongListDetailResponse>[1] = {},
): Promise<SongListDetailResponse | null> => {
  try {
    const adapted = toSongListDetailResponse(await readWithCredential(disstid), adaptOptions);
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
  readPublicPlaylist: readPublic = readPublicSongListDetail,
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
    .then(async (res: HttpClientResponse<any>) => {
      const response = res.data;
      logServiceSuccess('songListDetail', upstream, response, {
        disstid: data.disstid,
      });
      const disstid = identifierOf(data.disstid);
      const unreadable =
        isDictionary(response) && numberOf(response.code) === ANONYMOUS_UNREADABLE_CODE;
      let fallback: SongListDetailResponse | null = null;
      if (unreadable && disstid && readWithCredential)
        fallback = await readAlgorithmicPlaylist(disstid, readWithCredential);
      else if (disstid && isPrivacyRejected(response)) {
        // 先匿名读（没登录的用户打开推荐歌单也会碰到）；读不到、请求又带着会话时再用凭据读。
        fallback = await readPublicPlaylist(disstid, readPublic);
        if (!fallback && readWithCredential)
          fallback = await readAlgorithmicPlaylist(disstid, readWithCredential, {
            publicPlaylist: true,
          });
      }
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
          error: toLegacyErrorBody(error),
        },
      };
    });
};
