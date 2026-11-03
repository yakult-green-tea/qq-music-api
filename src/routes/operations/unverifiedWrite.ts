import { QqApiError, toNewRouteErrorResponse } from '../../protocol/errors';
import type { AuthSession } from '../../services/auth/qrLogin';
import type { OperationHandler, OperationResult } from './types';

type SessionWrite = (session: AuthSession, body: unknown) => Promise<OperationResult>;

/** 已经真账号写后读回验收过的写入：只要 POST 和有效会话，不看实验开关。 */
export const sessionWrite =
  (execute: SessionWrite): OperationHandler =>
  async (request) => {
    if (request.method !== 'POST')
      return {
        status: 405,
        headers: { Allow: 'POST' },
        body: { code: 405, message: 'POST required' },
      };
    const session = await (await request.service()).resolveSession(request.token);
    if (!session) return toNewRouteErrorResponse(new QqApiError('auth-missing'));
    let body: unknown;
    try {
      body = await request.body?.();
    } catch {
      return toNewRouteErrorResponse(new QqApiError('input'));
    }
    return execute(session, body);
  };

/** 真账号双向验证前，只允许可信宿主明确开启的测试入口。 */
export const unverifiedWrite =
  (execute: SessionWrite): OperationHandler =>
  async (request) => {
    if (request.method === 'POST' && !request.unverifiedWritesEnabled)
      return toNewRouteErrorResponse(new QqApiError('feature-unavailable'));
    return sessionWrite(execute)(request);
  };
