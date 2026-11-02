import {
  officialRadioModesResult,
  officialRadioTracksResult,
} from '../../services/recommend/officialRadio';
import { rawQuery, requiredSession } from './requestValues';
import type { OperationHandler, OperationRequest } from './types';

// 普通雷达选项与批次只读；不把未知模式或分页参数收下后忽略。
const unsupportedQuery = (request: OperationRequest) =>
  ['page', 'cursor', 'mode', 'submode', 'scene_id'].some(
    (key) => rawQuery(request, key) !== undefined,
  );

export const getRadioRecommendationModes: OperationHandler = async (request) =>
  officialRadioModesResult(
    await requiredSession(request),
    unsupportedQuery(request) || rawQuery(request, 'id') !== undefined,
  );

export const getRadioRecommendationTracks: OperationHandler = async (request) =>
  officialRadioTracksResult(
    await requiredSession(request),
    rawQuery(request, 'id'),
    unsupportedQuery(request),
  );
