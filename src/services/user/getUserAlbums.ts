import qrLoginService from '../auth/qrLogin.node';

// src/services/user/getUserAlbums.ts

export interface UserAlbumsParams {
  token?: string;
  offset?: number;
  limit?: number;
}

export default async ({ token, offset, limit }: UserAlbumsParams) =>
  qrLoginService.getUserAlbums(token, offset, limit);
