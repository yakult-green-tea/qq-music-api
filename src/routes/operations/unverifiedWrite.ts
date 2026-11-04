import { QqApiError, toNewRouteErrorResponse } from '../../protocol/errors';
import type { AuthSession } from '../../services/auth/qrLogin';
import type { OperationHandler, OperationRequest, OperationResult } from './types';

type SessionWrite = (session: AuthSession, body: unknown) => Promise<OperationResult>;

/**
 * 新写入只收 `application/json`。跨站页面不经预检就能发出的只有表单和纯文本，带着 Cookie 也写不进来；
 * 这里不开放带凭证的 CORS，JSON 请求要过预检，别的来源发不出。旧写入路由照旧，不改它们的契约。
 */
export const jsonRequired = (request: OperationRequest): OperationResult | null =>
  /^application\/json\s*(;|$)/i.test(request.contentType?.trim() ?? '')
    ? null
    : {
        status: 415,
        headers: { Accept: 'application/json' },
        body: { code: 415, message: 'application/json required' },
      };

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
    const unsupportedType = jsonRequired(request);
    if (unsupportedType) return unsupportedType;
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
