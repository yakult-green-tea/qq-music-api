import { WEB_ANONYMOUS_COMM } from '../../protocol/clientProfiles';
import u_common from '../../services/u_common';
import type { OperationHandler } from './types';

// src/routes/operations/getSingerHotsong.ts
// 歌手热门歌曲。默认 page 为 0，旧偏移量因此为负数；搬迁保留它，不在这里改分页规则。
export const getSingerHotsong: OperationHandler = async ({ runtime, queryRaw }) => {
  const singermid = queryRaw('singermid');
  if (!singermid) {
    return {
      status: 400,
      headers: {},
      body:
        runtime === 'node' ? { response: 'no singermid' } : { data: { message: 'no singermid' } },
    };
  }
  const num = Number(queryRaw('limit') || 5);
  const page = Number(queryRaw('page') || 0);
  const response = await u_common({
    method: 'get',
    options: {
      params: {
        format: 'json',
        singermid,
        data: JSON.stringify({
          comm: WEB_ANONYMOUS_COMM,
          singer: {
            method: 'get_singer_detail_info',
            param: { sort: 5, singermid, sin: (page - 1) * num, num },
            module: 'music.web_singer_info_svr',
          },
        }),
      },
    },
  });
  return { status: 200, headers: {}, body: { response: response.data } };
};
