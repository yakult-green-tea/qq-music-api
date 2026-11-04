import {
  recommendationPreferencesResult,
  recommendationPreferencesUpdateResult,
} from '../../services/recommend/preferences';
import { rawQuery, requiredSession } from './requestValues';
import type { OperationHandler } from './types';
import { sessionWrite } from './unverifiedWrite';

// 音乐偏好只读当前账号；入口、电台或单项参数不收下后忽略。
export const getRecommendationPreferences: OperationHandler = async (request) =>
  recommendationPreferencesResult(
    await requiredSession(request),
    ['station', 'entry', 'profileKey', 'page', 'cursor', 'id'].some(
      (key) => rawQuery(request, key) !== undefined,
    ),
  );

// QQ 与微信账号都实写过、读回一致，不再要实验开关；照旧读现值→只换指定项→整份写一次→读回。
export const updateRecommendationPreferences = sessionWrite(recommendationPreferencesUpdateResult);
