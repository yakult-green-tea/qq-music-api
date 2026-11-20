import { QqApiError } from '../../protocol/errors';
import type { MusicuDescriptor } from '../../protocol/musicu';
import { type Dictionary, dictionaryOf, isDictionary } from '../../util/values';
import type { AuthSession } from '../auth/qrLogin';
import { failureResult, type NewRouteResult, okResult } from '../recommend/newRouteResult';
import { createSessionMusicuClient, type SessionMusicuOptions } from '../recommend/sessionMusicu';

// src/services/user/medals.ts
//
// `/user/medals`：本人勋章馆的一个分页。Node 与 serverless 共用。
// 实测（2026-11，带会话）：`music.medalHall.MedalHallHomepageSrv.GetHomepageTabDetail { EncUin, TabID,
// SupportCardStyle: true }` 回 `TabInfo.ModuleList[{ ModuleID, ModuleName, MedalList[...], Style{ HasNext } }]`。
// 分页对照按模块名称对出来：2 乐迷、4 畅听、5 限定、6 珍爱守护、11 书迷、12 好友、13 幸运盲盒、
// 14 会员尊享、15 里程碑。回应里也有还没拿到的勋章，所以不推断「已获得」；取得时间只在有值时原样给。
// 「乐迷」分页的勋章可能没有 id。跳转链接、提示文字不交出；分页里的子分类不往下读。

const TABS = {
  fans: 2,
  listening: 4,
  limited: 5,
  guardian: 6,
  books: 11,
  friends: 12,
  'blind-box': 13,
  vip: 14,
  milestones: 15,
} as const;
type Tab = keyof typeof TABS;

const tabOf = (raw: unknown): Tab => {
  if (typeof raw !== 'string' || !Object.hasOwn(TABS, raw)) throw new QqApiError('input');
  return raw as Tab;
};

const stringOf = (value: unknown): string => (typeof value === 'string' ? value : '');
const countOf = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

const tabDetail = (encryptedUin: string, tab: Tab): MusicuDescriptor<Dictionary> => ({
  module: 'music.medalHall.MedalHallHomepageSrv',
  method: 'GetHomepageTabDetail',
  param: { EncUin: encryptedUin, TabID: TABS[tab], SupportCardStyle: true },
  readOnly: true,
  operation: 'user.medals',
  decode: (data) => {
    if (!isDictionary(data)) throw new QqApiError('invalid-response');
    return data;
  },
});

const toMedal = (row: unknown): Dictionary | null => {
  const item = dictionaryOf(row);
  const name = stringOf(item.Name);
  if (!name) return null;
  const id = stringOf(item.MedalID);
  const obtainedAt = stringOf(item.CreateTime);
  const level = countOf(item.Level);
  return {
    ...(id ? { id } : {}),
    name,
    icon: stringOf(item.PicURL),
    ...(level === undefined ? {} : { level }),
    ...(obtainedAt ? { obtainedAt } : {}),
    ...(typeof item.IsNew === 'boolean' ? { isNew: item.IsNew } : {}),
  };
};

const toModule = (row: unknown): Dictionary | null => {
  const item = dictionaryOf(row);
  if (item.MedalList != null && !Array.isArray(item.MedalList))
    throw new QqApiError('invalid-response');
  const id = countOf(item.ModuleID);
  if (id === undefined) return null;
  return {
    id,
    name: stringOf(item.ModuleName),
    more: dictionaryOf(item.Style).HasNext === true,
    medals: (Array.isArray(item.MedalList) ? item.MedalList : [])
      .map(toMedal)
      .filter((medal) => medal !== null),
  };
};

/** 分页是空的回 200 空数组；没有分页资料或有模块却一个都读不出来回 502。 */
export const medalsResult = async (
  session: AuthSession | null,
  rawTab: unknown,
  options: SessionMusicuOptions = {},
): Promise<NewRouteResult> => {
  try {
    if (!session) throw new QqApiError('auth-missing');
    const tab = tabOf(rawTab);
    const encryptedUin = session.credential.encryptUin;
    if (typeof encryptedUin !== 'string' || !encryptedUin) throw new QqApiError('unexpected');
    const data = await createSessionMusicuClient(session, options).execute(
      tabDetail(encryptedUin, tab),
    );
    if (!isDictionary(data.TabInfo)) throw new QqApiError('invalid-response');
    const list = data.TabInfo.ModuleList;
    if (list !== null && list !== undefined && !Array.isArray(list))
      throw new QqApiError('invalid-response');
    const rows = Array.isArray(list) ? list : [];
    const modules = rows.map(toModule).filter((item) => item !== null);
    if (rows.length && !modules.length) throw new QqApiError('invalid-response');
    return okResult({ tab, modules });
  } catch (error) {
    return failureResult('get-medals', error);
  }
};
