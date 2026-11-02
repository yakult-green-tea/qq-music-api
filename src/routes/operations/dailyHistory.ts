import {
  dailyHistoryDatesResult,
  dailyHistorySongsResult,
} from '../../services/recommend/dailyHistory';
import { rawQuery, requiredSession } from './requestValues';
import type { OperationHandler } from './types';

// 日推历史只读当前账号；指定日与日期目录使用不同路径，两个宿主共用同一实现。
export const dailyHistoryDates: OperationHandler = async (request) =>
  dailyHistoryDatesResult(await requiredSession(request));

export const dailyHistorySongs: OperationHandler = async (request) =>
  dailyHistorySongsResult(await requiredSession(request), rawQuery(request, 'date'));
