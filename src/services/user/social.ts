import { QqApiError } from '../../protocol/errors';
import type { MusicuDescriptor } from '../../protocol/musicu';
import { type Dictionary, isDictionary } from '../../util/values';
import type { AuthSession } from '../auth/qrLogin';
import { failureResult, type NewRouteResult, okResult } from '../recommend/newRouteResult';
import { createSessionMusicuClient, type SessionMusicuOptions } from '../recommend/sessionMusicu';

// src/services/user/social.ts
//
// 社交：`/user/following/singers`、`/user/following/users`、`/user/followers`、`/user/friends`。
// Node 与 serverless 共用，只读本人第一页。实测（2026-11，带会话，Android）四支都 code 0：
// `music.concern.RelationList.GetFollowSingerList`／`GetFollowUserList { HostUin, MID: '', From, Size, FromPos }`、
// `GetFansList { HostUin, From, Size, FromPos }` 回 `{ Total, List: [{ MID, EncUin, Name, Desc, AvatarUrl, FanNum,
// IsFollow, ... }], HasMore（布尔）, LastPos, LockFlag, LockMsg, SelfInfo }`；`music.homepage.Friendship.GetFriendList
// { Page: 0, PageSize: 50 }` 回 `{ Friends: [{ EncryptUin, UserName, IsFollow（数字）, AvatarUrl, VipInfo }], HasMore（数字） }`。
// 歌手有 MID、一般用户有 EncUin。会员图标、勋章、隐私提示文字、自己的资料不交出；LockFlag 非 0 回 locked。

const RELATION_SIZE = 20;
const FRIEND_PAGE_SIZE = 50;

export type RelationKind = 'following-singers' | 'following-users' | 'followers';
const RELATION_METHODS: Record<RelationKind, { method: string; withMid: boolean }> = {
  'following-singers': { method: 'GetFollowSingerList', withMid: true },
  'following-users': { method: 'GetFollowUserList', withMid: true },
  followers: { method: 'GetFansList', withMid: false },
};

const stringOf = (value: unknown): string => (typeof value === 'string' ? value : '');
const countOf = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

const decodeDictionary = (data: unknown): Dictionary => {
  if (!isDictionary(data)) throw new QqApiError('invalid-response');
  return data;
};

const encryptedUinOf = (session: AuthSession): string => {
  const value = session.credential.encryptUin;
  if (typeof value !== 'string' || !value) throw new QqApiError('unexpected');
  return value;
};

/** null／缺省是空，其他非数组是格式变了；有条目却一个都读不出来回 502。 */
const itemsOf = (list: unknown, toItem: (row: unknown) => Dictionary | null): Dictionary[] => {
  if (list !== null && list !== undefined && !Array.isArray(list))
    throw new QqApiError('invalid-response');
  const rows = Array.isArray(list) ? list : [];
  const items = rows.map(toItem).filter((item) => item !== null);
  if (rows.length && !items.length) throw new QqApiError('invalid-response');
  return items;
};

const toPerson = (row: unknown): Dictionary | null => {
  if (!isDictionary(row)) return null;
  const name = stringOf(row.Name);
  const mid = stringOf(row.MID);
  const encUin = stringOf(row.EncUin);
  if (!name || (!mid && !encUin)) return null;
  const fanCount = countOf(row.FanNum);
  return {
    mid,
    encUin,
    name,
    desc: stringOf(row.Desc),
    avatar: stringOf(row.AvatarUrl),
    ...(fanCount === undefined ? {} : { fanCount }),
    ...(typeof row.IsFollow === 'boolean' ? { followed: row.IsFollow } : {}),
  };
};

export const relationListResult = async (
  kind: RelationKind,
  session: AuthSession | null,
  options: SessionMusicuOptions = {},
): Promise<NewRouteResult> => {
  try {
    if (!session) throw new QqApiError('auth-missing');
    const { method, withMid } = RELATION_METHODS[kind];
    const descriptor: MusicuDescriptor<Dictionary> = {
      module: 'music.concern.RelationList',
      method,
      param: {
        HostUin: encryptedUinOf(session),
        ...(withMid ? { MID: '' } : {}),
        From: 0,
        Size: RELATION_SIZE,
        FromPos: '',
      },
      readOnly: true,
      operation: 'user.social',
      decode: decodeDictionary,
    };
    const data = await createSessionMusicuClient(session, options).execute(descriptor);
    const lockFlag = data.LockFlag;
    if (lockFlag !== undefined && lockFlag !== 0) {
      if (typeof lockFlag !== 'number') throw new QqApiError('invalid-response');
      return okResult({ items: [], total: countOf(data.Total) ?? null, more: false, locked: true });
    }
    return okResult({
      items: itemsOf(data.List, toPerson),
      total: countOf(data.Total) ?? null,
      more: data.HasMore === true,
    });
  } catch (error) {
    return failureResult('get-social', error);
  }
};

const toFriend = (row: unknown): Dictionary | null => {
  if (!isDictionary(row)) return null;
  const encUin = stringOf(row.EncryptUin);
  if (!encUin) return null;
  return {
    encUin,
    name: stringOf(row.UserName),
    avatar: stringOf(row.AvatarUrl),
    ...(row.IsFollow === 1 ? { followed: true } : row.IsFollow === 0 ? { followed: false } : {}),
  };
};

const FRIENDS: MusicuDescriptor<Dictionary> = {
  module: 'music.homepage.Friendship',
  method: 'GetFriendList',
  param: { Page: 0, PageSize: FRIEND_PAGE_SIZE },
  readOnly: true,
  operation: 'user.social',
  decode: decodeDictionary,
};

export const friendsResult = async (
  session: AuthSession | null,
  options: SessionMusicuOptions = {},
): Promise<NewRouteResult> => {
  try {
    if (!session) throw new QqApiError('auth-missing');
    const data = await createSessionMusicuClient(session, options).execute(FRIENDS);
    return okResult({
      items: itemsOf(data.Friends, toFriend),
      more: data.HasMore === 1 || data.HasMore === true,
    });
  } catch (error) {
    return failureResult('get-social', error);
  }
};
