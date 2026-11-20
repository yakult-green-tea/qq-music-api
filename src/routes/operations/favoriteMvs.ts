import { favoriteMvsResult } from '../../services/user/favoriteMvs';
import { rawQuery, requiredSession } from './requestValues';
import type { OperationHandler } from './types';

// 本人收藏的 MV：上游没有分页，page 只能省略或是 1。
export const getFavoriteMvs: OperationHandler = async (request) =>
  favoriteMvsResult(await requiredSession(request), rawQuery(request, 'page'));
