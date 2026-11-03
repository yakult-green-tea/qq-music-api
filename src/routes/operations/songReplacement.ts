import { songReplacementResult } from '../../services/song/replacement';
import { requiredSession } from './requestValues';
import type { OperationHandler } from './types';

// 替代歌曲要登录：取链接用当前会话，两个宿主共用同一实现。
export const songReplacement: OperationHandler = async (request) => {
  const session = await requiredSession(request);
  const service = await request.service();
  return songReplacementResult(session, request.query('mid'), (mids) =>
    service.getMusicPlay(request.token, mids.join(','), '128'),
  );
};
