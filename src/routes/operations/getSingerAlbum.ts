import { WEB_ANONYMOUS_COMM } from '../../protocol/clientProfiles';
import u_common from '../../services/u_common';
import type { OperationHandler } from './types';

// src/routes/operations/getSingerAlbum.ts
// 歌手专辑。缺参数的两种回包与重复查询的数值转换照旧，业务码不改 HTTP 状态。
export const getSingerAlbum: OperationHandler = async ({ runtime, queryRaw }) => {
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
  const begin = Number(queryRaw('page') || 0);
  const response = await u_common({
    method: 'get',
    options: {
      params: {
        format: 'json',
        singermid,
        data: JSON.stringify({
          comm: WEB_ANONYMOUS_COMM,
          singer: {
            method: 'GetAlbumList',
            param: { sort: 5, singermid, begin, num },
            module: 'music.musichallAlbum.AlbumListServer',
          },
        }),
      },
    },
  });
  return { status: 200, headers: {}, body: { response: response.data } };
};
