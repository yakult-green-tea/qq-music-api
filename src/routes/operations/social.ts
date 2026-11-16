import { friendsResult, relationListResult } from '../../services/user/social';
import { requiredSession } from './requestValues';
import type { OperationHandler } from './types';

// 社交：只读本人第一页，没有业务参数。
export const getFollowingSingers: OperationHandler = async (request) =>
  relationListResult('following-singers', await requiredSession(request));

export const getFollowingUsers: OperationHandler = async (request) =>
  relationListResult('following-users', await requiredSession(request));

export const getFollowers: OperationHandler = async (request) =>
  relationListResult('followers', await requiredSession(request));

export const getFriends: OperationHandler = async (request) =>
  friendsResult(await requiredSession(request));
