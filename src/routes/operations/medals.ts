import { medalsResult } from '../../services/user/medals';
import { rawQuery, requiredSession } from './requestValues';
import type { OperationHandler } from './types';

// 本人勋章馆的一个分页：tab 必填，用分页名字。
export const getMedals: OperationHandler = async (request) =>
  medalsResult(await requiredSession(request), rawQuery(request, 'tab'));
