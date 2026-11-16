import { likedCategoriesResult } from '../../services/user/likedCategories';
import { requiredSession } from './requestValues';
import type { OperationHandler } from './types';

// 「我喜欢」的分类：要登录，没有业务参数。
export const getLikedSongCategories: OperationHandler = async (request) =>
  likedCategoriesResult(await requiredSession(request));
