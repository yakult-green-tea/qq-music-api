import { similarAutoplayResult } from '../../services/recommend/autoplay';
import { rawQuery, requiredSession } from './requestValues';
import type { OperationHandler } from './types';

// 相似歌曲接歌：只收一首种子歌的数字 id。
export const getAutoplaySimilar: OperationHandler = async (request) =>
  similarAutoplayResult(await requiredSession(request), rawQuery(request, 'id'));
