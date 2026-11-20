import { playlistUpdatesResult } from '../../services/user/playlistUpdates';
import { requiredSession } from './requestValues';
import type { OperationHandler } from './types';

// 收藏歌单里哪些有新歌：只读收藏歌单第一页。
export const getPlaylistUpdates: OperationHandler = async (request) =>
  playlistUpdatesResult(await requiredSession(request));
