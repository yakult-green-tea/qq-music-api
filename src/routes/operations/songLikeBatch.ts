import { songLikeBatchResult } from '../../services/user/songLikeBatch';
import { sessionWrite } from './unverifiedWrite';

// 批量「我喜欢」：QQ 与微信登录、Node 与 serverless 都做过真账号加入、重送、移出与读回，默认开放。
export const songLikeBatch = sessionWrite(songLikeBatchResult);
