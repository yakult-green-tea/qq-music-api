import { singerRankResult } from '../../services/user/singerRank';
import { rawQuery, requiredSession } from './requestValues';
import type { OperationHandler } from './types';

// 本人的歌手榜：range 必填（year、all、month、last-year）。
export const getSingerRank: OperationHandler = async (request) =>
  singerRankResult(await requiredSession(request), rawQuery(request, 'range'));
