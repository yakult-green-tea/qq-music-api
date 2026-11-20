import { friendRankResult } from '../../services/user/friendRank';
import { requiredSession } from './requestValues';
import type { OperationHandler } from './types';

// 好友听歌日榜：要登录，只读第一页。
export const getFriendRank: OperationHandler = async (request) =>
  friendRankResult(await requiredSession(request));
