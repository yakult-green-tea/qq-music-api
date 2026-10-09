import qrLoginService from '../auth/qrLogin.node';

// src/services/songLists/getAuthenticatedSongListDetail.ts

export interface AuthenticatedSongListDetailParams {
  token?: string;
  disstid?: number | string;
}

/** Node 入口用的带凭据读歌单；serverless 由它自己每次请求建的 service 直接调用同一个方法。 */
export default async ({ token, disstid }: AuthenticatedSongListDetailParams) =>
  qrLoginService.getAuthenticatedSongListDetail(token, disstid);
