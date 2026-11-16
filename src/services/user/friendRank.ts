import { normalizeQqFailure, QqApiError } from '../../protocol/errors';
import type { MusicuDescriptor } from '../../protocol/musicu';
import { type Dictionary, dictionaryOf, isDictionary } from '../../util/values';
import type { AuthSession } from '../auth/qrLogin';
import { failureResult, type NewRouteResult, okResult } from '../recommend/newRouteResult';
import { createSessionMusicuClient, type SessionMusicuOptions } from '../recommend/sessionMusicu';

// src/services/user/friendRank.ts
//
// `/user/friend-rank`：好友听歌日榜，只读第一页。Node 与 serverless 共用。
// 实测（2026-11，带会话）：`music.activeCenter.FriendRankSvr.GetRank { rank_type: 1, offset: 0, limit: 60,
// last_uin: '', rankno: 0 }` 回 `{ code, ranks: [{ uin, nick, pic, play_time, like_num, like_status, no, ... }],
// my_rank_no, my_play_time, has_more, rankno, my_like_num }`。`my_play_time` 等于听歌报告当天的听歌秒数，
// 所以是日榜。`uin` 是加密 id。点赞、隐私设置是写入，不做；勋章装饰、音乐力快照不交出。

const FIRST_PAGE: MusicuDescriptor<Dictionary> = {
  module: 'music.activeCenter.FriendRankSvr',
  method: 'GetRank',
  param: { rank_type: 1, offset: 0, limit: 60, last_uin: '', rankno: 0 },
  readOnly: true,
  operation: 'user.friend-rank',
  decode: (data) => {
    if (!isDictionary(data)) throw new QqApiError('invalid-response');
    return data;
  },
};

const countOf = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const positiveOf = (value: unknown): number | undefined => {
  const count = countOf(value);
  return count ? count : undefined;
};
const numbers = (pairs: Array<[string, unknown]>): Dictionary =>
  Object.fromEntries(pairs.filter(([, value]) => value !== undefined));

const toFriend = (row: unknown): Dictionary | null => {
  const item = dictionaryOf(row);
  const uin = typeof item.uin === 'string' ? item.uin : '';
  if (!uin) return null;
  return {
    uin,
    nick: typeof item.nick === 'string' ? item.nick : '',
    avatar: typeof item.pic === 'string' ? item.pic : '',
    ...numbers([
      ['playSeconds', countOf(item.play_time)],
      ['likeCount', countOf(item.like_num)],
      ['liked', item.like_status === 1 ? true : item.like_status === 0 ? false : undefined],
      ['rank', positiveOf(item.no)],
    ]),
  };
};

/** 榜上没人回 200 空数组；有条目却一个都读不出来回 502。`more` 只照抄 has_more，没有下一页可读。 */
export const friendRankResult = async (
  session: AuthSession | null,
  options: SessionMusicuOptions = {},
): Promise<NewRouteResult> => {
  try {
    if (!session) throw new QqApiError('auth-missing');
    const data = await createSessionMusicuClient(session, options).execute(FIRST_PAGE);
    const { code } = data;
    if (code !== undefined) {
      if (typeof code !== 'number' || !Number.isSafeInteger(code))
        throw new QqApiError('invalid-response');
      if (code !== 0) throw normalizeQqFailure({ source: 'business', upstreamCode: code });
    }
    const list = data.ranks;
    if (list !== null && list !== undefined && !Array.isArray(list))
      throw new QqApiError('invalid-response');
    const rows = Array.isArray(list) ? list : [];
    const items = rows.map(toFriend).filter((item) => item !== null);
    if (rows.length && !items.length) throw new QqApiError('invalid-response');
    return okResult({
      items,
      ...numbers([
        ['myRank', positiveOf(data.my_rank_no)],
        ['myPlaySeconds', countOf(data.my_play_time)],
        ['myLikeCount', countOf(data.my_like_num)],
      ]),
      more: data.has_more === 1 || data.has_more === true,
    });
  } catch (error) {
    return failureResult('get-friend-rank', error);
  }
};
