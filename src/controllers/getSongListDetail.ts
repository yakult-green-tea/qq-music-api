import services from '../services';

const { songListDetail, getAuthenticatedSongListDetail } = services;

/**
 * @description: 2, 3
 * @param {page} 页数
 * @param {limit} 每页条数[20, 60]
 * @param {categoryId} 分类
 * @param {sortId} 分类
 * @return:
 */
import { Context } from 'koa';
import { getTypedParams, getTypedQuery } from '../types/core/request';
import { getAuthToken } from './login';

interface SongListDetailParams {
  disstid?: string;
}

export default async (ctx: Context) => {
  const path = getTypedParams<SongListDetailParams>(ctx);
  const query = getTypedQuery<SongListDetailParams>(ctx);
  const disstid = path.disstid ?? query.disstid;
  // 会话只在匿名 CGI 读不到（算法歌单）时才用到，也不会被带进匿名 CGI 的参数里
  const token = getAuthToken(ctx);
  const props = {
    method: 'get',
    params: {
      disstid,
    },
    option: {},
    ...(token
      ? {
          readWithCredential: (id: string) =>
            getAuthenticatedSongListDetail({ token, disstid: id }),
        }
      : {}),
  };
  const { status, body } = await songListDetail(props);
  Object.assign(ctx, {
    status,
    body,
  });
};
