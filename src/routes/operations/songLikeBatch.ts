import { songLikeBatchResult } from '../../services/user/songLikeBatch';
import { unverifiedWrite } from './unverifiedWrite';

// 批量「我喜欢」：真账号双向实写通过前，只有可信宿主开 QQ_UNVERIFIED_WRITES_ENABLED 才能用。
export const songLikeBatch = unverifiedWrite(songLikeBatchResult);
