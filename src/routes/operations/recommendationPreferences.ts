import { recommendationPreferencesResult } from '../../services/recommend/preferences';
import { rawQuery, requiredSession } from './requestValues';
import type { OperationHandler } from './types';

// 音乐偏好只读当前账号；入口、电台或单项参数不收下后忽略。
export const getRecommendationPreferences: OperationHandler = async (request) =>
  recommendationPreferencesResult(
    await requiredSession(request),
    ['station', 'entry', 'profileKey', 'page', 'cursor', 'id'].some(
      (key) => rawQuery(request, key) !== undefined,
    ),
  );
