import {
  recommendationPreferencesResult,
  recommendationPreferencesUpdateResult,
} from '../../services/recommend/preferences';
import { rawQuery, requiredSession } from './requestValues';
import type { OperationHandler } from './types';
import { unverifiedWrite } from './unverifiedWrite';

// 音乐偏好只读当前账号；入口、电台或单项参数不收下后忽略。
export const getRecommendationPreferences: OperationHandler = async (request) =>
  recommendationPreferencesResult(
    await requiredSession(request),
    ['station', 'entry', 'profileKey', 'page', 'cursor', 'id'].some(
      (key) => rawQuery(request, key) !== undefined,
    ),
  );

// 写入在真账号写后读回验收前沿用可信宿主的实验开关；请求参数不能开启它。
export const updateRecommendationPreferences = unverifiedWrite(
  recommendationPreferencesUpdateResult,
);
