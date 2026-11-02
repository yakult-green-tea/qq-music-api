import {
  blacklistAddResult,
  blacklistRemoveResult,
} from '../../services/recommend/blacklistWrites';
import { unverifiedWrite } from './unverifiedWrite';

// 完整真账号写后读回验收前，沿用可信宿主的实验写入开关；请求参数不能开启它。
export const addBlacklist = unverifiedWrite(blacklistAddResult);
export const removeBlacklist = unverifiedWrite(blacklistRemoveResult);
