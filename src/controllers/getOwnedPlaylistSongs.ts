import type { Context } from 'koa';
import services from '../services';
import { getTypedQuery } from '../types/core/request';
import { getAuthToken } from './login';

// src/controllers/getOwnedPlaylistSongs.ts

interface OwnedPlaylistSongsQuery {
  tid?: string;
  dirid?: string;
  offset?: string;
  limit?: string;
}

const idOf = (value?: string): number => (/^\d+$/.test(value ?? '') ? Number(value) : 0);

/**
 * Songs of a playlist the logged-in user owns, read with their credential. Same response shape as
 * `/user/liked-songs`, which is this route with `dirid=201`.
 */
export default async (ctx: Context): Promise<void> => {
  const query = getTypedQuery<OwnedPlaylistSongsQuery>(ctx);
  const disstid = idOf(query.tid);
  const dirid = idOf(query.dirid);
  if (!disstid && !dirid) {
    ctx.status = 400;
    ctx.body = { code: 400, message: 'tid or dirid is required' };
    return;
  }
  const offset = Math.max(0, Number.parseInt(query.offset ?? '0', 10) || 0);
  const limit = Math.min(100, Math.max(1, Number.parseInt(query.limit ?? '100', 10) || 100));
  const data = await services.getOwnedPlaylistSongs({
    token: getAuthToken(ctx),
    disstid,
    dirid,
    offset,
    limit,
  });
  if (!data) {
    ctx.status = 401;
    ctx.body = { code: 401, message: 'Login required' };
    return;
  }
  const songs = Array.isArray(data.songlist) ? data.songlist : [];
  const total = typeof data.total_song_num === 'number' ? data.total_song_num : songs.length;
  ctx.status = 200;
  ctx.body = {
    code: 200,
    songs,
    total,
    more: data.hasmore === true || Number(data.hasmore) === 1 || offset + songs.length < total,
  };
};
