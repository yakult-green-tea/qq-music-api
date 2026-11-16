import { recentPlaysResult } from '../../services/user/recentPlays';
import { rawQuery, requiredSession } from './requestValues';
import type { OperationHandler } from './types';

// 云端最近播放：只读，type 选分类，默认歌曲。
export const getRecentPlays: OperationHandler = async (request) =>
  recentPlaysResult(await requiredSession(request), rawQuery(request, 'type'));
