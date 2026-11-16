import { soundPowerResult } from '../../services/user/soundPower';
import { requiredSession } from './requestValues';
import type { OperationHandler } from './types';

// 本人的音乐力等级：要登录，没有业务参数。
export const getSoundPower: OperationHandler = async (request) =>
  soundPowerResult(await requiredSession(request));
