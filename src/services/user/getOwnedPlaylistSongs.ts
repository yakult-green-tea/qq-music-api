import type { OwnedPlaylistSongsParams as ServiceParams } from '../auth/qrLogin';
import qrLoginService from '../auth/qrLogin.node';

// src/services/user/getOwnedPlaylistSongs.ts

export interface OwnedPlaylistSongsParams extends ServiceParams {
  token?: string;
}

export default async ({ token, ...params }: OwnedPlaylistSongsParams) =>
  qrLoginService.getOwnedPlaylistSongs(token, params);
