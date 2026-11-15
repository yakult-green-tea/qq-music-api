import { WEB_ANONYMOUS_COMM } from '../../protocol/clientProfiles';
import { getLegacyHttpTransport } from '../../services/httpTransport';
import u_common from '../../services/u_common';
import type { OperationHandler } from './types';

// src/routes/operations/getSongInfo.ts
// 单曲详情原样转交。路径优先，重复查询保留 Node 的数组和 serverless 的第一项。
export const getSongInfo: OperationHandler = async ({ runtime, params, queryRaw }) => {
  const song_mid = params.songmid ?? queryRaw('songmid');
  const song_id = params.songid ?? queryRaw('songid') ?? '';
  const queryParams = {
    ...(runtime === 'node'
      ? {
          ...getLegacyHttpTransport().defaults.commonParams,
          inCharset: 'utf8',
          outCharset: 'utf-8',
          notice: 0,
          platform: 'yqq.json',
          needNewCode: 0,
        }
      : {}),
    format: 'json',
    data: JSON.stringify({
      comm: WEB_ANONYMOUS_COMM,
      songinfo: {
        method: 'get_song_detail_yqq',
        param: { song_type: 0, song_mid, song_id },
        module: 'music.pf_song_detail_svr',
      },
    }),
  };
  const response = await u_common({ method: 'get', options: { params: queryParams } });
  return { status: 200, headers: {}, body: { response: response.data } };
};
