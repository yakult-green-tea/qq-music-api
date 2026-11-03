import { QqApiError, toNewRouteErrorResponse } from '../../protocol/errors';
import {
  blacklistAddResult,
  blacklistRemoveResult,
} from '../../services/recommend/blacklistWrites';
import { isDictionary } from '../../util/values';
import type { OperationHandler } from './types';
import { jsonRequired, unverifiedWrite } from './unverifiedWrite';

const experimentalAdd = unverifiedWrite(blacklistAddResult);

// 只选歌曲的不喜欢已有真账号写后读回，默认开放；歌手、风格、混合选择与取消仍要可信宿主的实验开关。
// 请求参数不能开启实验写入：不是纯歌曲的请求在检查会话前就回 501。
export const addBlacklist: OperationHandler = async (request) => {
  if (request.method !== 'POST' || request.unverifiedWritesEnabled) return experimentalAdd(request);
  const unsupportedType = jsonRequired(request);
  if (unsupportedType) return unsupportedType;
  let body: unknown;
  try {
    body = await request.body?.();
  } catch {
    // 读不出的请求体不是纯歌曲选择，和开关关闭时的其他写入一样回 501。
    body = undefined;
  }
  if (!isDictionary(body) || Object.keys(body).join() !== 'songs')
    return toNewRouteErrorResponse(new QqApiError('feature-unavailable'));
  const session = await (await request.service()).resolveSession(request.token);
  if (!session) return toNewRouteErrorResponse(new QqApiError('auth-missing'));
  return blacklistAddResult(session, body);
};
export const removeBlacklist = unverifiedWrite(blacklistRemoveResult);
