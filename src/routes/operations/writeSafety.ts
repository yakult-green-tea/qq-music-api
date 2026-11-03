import type { OperationHandler, OperationRequest, OperationResult } from './types';

export const refusedAccountWrite = (request: OperationRequest): OperationResult | undefined => {
  if (
    request.method === 'POST' &&
    request.tokenSource === 'cookie' &&
    (request.fetchSite === 'same-site' || request.fetchSite === 'cross-site')
  )
    return { status: 403, headers: {}, body: { code: 403, message: 'cross-site request refused' } };
  return undefined;
};

export const protectAccountWrite =
  (handler: OperationHandler): OperationHandler =>
  (request: OperationRequest) => {
    const refused = refusedAccountWrite(request);
    if (refused) return Promise.resolve(refused);
    return handler(request);
  };
