import { listeningRankResult } from '../../services/recommend/listeningRank';
import { rawQuery, requiredSession } from './requestValues';
import type { OperationHandler } from './types';

// 本人的听歌排行；只认 range、date、token，别的参数（含 uin、分页）一律拒绝，不读别人的。
export const getListeningRank: OperationHandler = async (request) =>
  listeningRankResult(await requiredSession(request), {
    range: rawQuery(request, 'range'),
    date: rawQuery(request, 'date'),
    token: rawQuery(request, 'token'),
    unsupported: ['uin', 'page', 'cursor', 'offset', 'limit', 'type', 'version'].some(
      (key) => rawQuery(request, key) !== undefined,
    ),
  });
