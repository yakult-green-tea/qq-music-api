import { hotCategoriesResult } from '../../services/search/suggest';
import { requiredSession } from './requestValues';
import type { OperationHandler } from './types';

// 按分类的热搜：要登录，没有业务参数。
export const getHotSearchCategories: OperationHandler = async (request) =>
  hotCategoriesResult(await requiredSession(request));
