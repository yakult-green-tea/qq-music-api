import { businessCardResult } from '../../services/user/businessCard';
import { requiredSession } from './requestValues';
import type { OperationHandler } from './types';

export const getBusinessCard: OperationHandler = async (request) =>
  businessCardResult(await requiredSession(request));
