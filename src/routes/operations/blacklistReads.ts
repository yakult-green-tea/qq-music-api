import {
  blacklistResult,
  blacklistStyleOptionsResult,
} from '../../services/recommend/blacklistReads';
import { rawQuery, requiredSession } from './requestValues';
import type { OperationHandler } from './types';

// 黑名单与风格候选只读当前会话；不接受未经验证的续页游标。
export const getBlacklist: OperationHandler = async (request) =>
  blacklistResult(
    await requiredSession(request),
    rawQuery(request, 'type'),
    rawQuery(request, 'page'),
    rawQuery(request, 'cursor'),
  );

export const getBlacklistStyleOptions: OperationHandler = async (request) =>
  blacklistStyleOptionsResult(await requiredSession(request), rawQuery(request, 'songId'));
