import { QqApiError } from '../../protocol/errors';
import type { MusicuDescriptor } from '../../protocol/musicu';
import { type Dictionary, dictionaryOf, isDictionary } from '../../util/values';
import type { AuthSession } from '../auth/qrLogin';
import { failureResult, type NewRouteResult, okResult } from '../recommend/newRouteResult';
import { createSessionMusicuClient, type SessionMusicuOptions } from '../recommend/sessionMusicu';
import { keywordOf, searchIdOf } from './search';

// src/services/search/suggest.ts
//
// `/search/hot`、`/search/suggest`：公开内容，一律匿名读，带了会话也不用。Node 与 serverless 共用。
// 实测（2026-10，匿名网页 comm）：热搜是 `HotkeyService.GetHotkeyForQQMusicMobile {}` → `vec_hotkey[]`
// （`query`、`title`、`description`…）；搜索建议是 `SmartBoxCgi.GetSmartBoxResult` → `items[]`，
// 搜索词是 `type 0`，同一个列表里还会夹别的条目（例如 AI 助手），只留搜索词。

const decodeDictionary = (data: unknown): Dictionary => {
  if (!isDictionary(data)) throw new QqApiError('invalid-response');
  return data;
};

const listOf = (value: unknown): unknown[] => {
  if (value !== null && value !== undefined && !Array.isArray(value))
    throw new QqApiError('invalid-response');
  return Array.isArray(value) ? value : [];
};

const textOf = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value : undefined;

const anonymous = (options: SessionMusicuOptions) => createSessionMusicuClient(null, options);

// ---- 热搜 ----

const HOT_SEARCHES: MusicuDescriptor<Dictionary> = {
  module: 'music.musicsearch.HotkeyService',
  method: 'GetHotkeyForQQMusicMobile',
  param: {},
  readOnly: true,
  operation: 'search.hot',
  decode: decodeDictionary,
};

/** 关键字去掉头尾空白；标题、说明只在是非空文字时给。跳转链接不给。 */
export const toHotkey = (entry: unknown): Dictionary | null => {
  const item = dictionaryOf(entry);
  const keyword = textOf(item.query)?.trim();
  if (keyword === undefined) return null;
  const optional: Array<[string, unknown]> = [
    ['title', textOf(item.title)],
    ['description', textOf(item.description)],
  ];
  return {
    keyword,
    ...Object.fromEntries(optional.filter(([, value]) => value !== undefined)),
  };
};

/** 上游给空清单回 422，给了条目却一个关键字都读不出来回 502。 */
export const hotSearchesResult = async (
  options: SessionMusicuOptions = {},
): Promise<NewRouteResult> => {
  try {
    const entries = listOf((await anonymous(options).execute(HOT_SEARCHES)).vec_hotkey);
    if (!entries.length) throw new QqApiError('not-found');
    const hotkeys = entries.map(toHotkey).filter(Boolean);
    if (!hotkeys.length) throw new QqApiError('invalid-response');
    return okResult({ hotkeys });
  } catch (error) {
    return failureResult('get-hot-searches', error);
  }
};

// ---- 搜索建议 ----

/** 搜索词条目的 `type`；其他值（例如 AI 助手的 7）不是搜索词。 */
const SUGGESTION_TYPE = 0;

const searchSuggestions = (keyword: string): MusicuDescriptor<Dictionary> => ({
  module: 'music.smartboxCgi.SmartBoxCgi',
  method: 'GetSmartBoxResult',
  param: { search_id: searchIdOf(), query: keyword, num_per_page: 0, page_idx: 0 },
  readOnly: true,
  operation: 'search.suggest',
  decode: decodeDictionary,
});

/**
 * 关键字和 `/search` 一样：去掉头尾空白后不能是空的，最多 60 个字，不对就回 400、不请求上游。
 * 没有任何搜索词条目回 422；有搜索词条目却一个都读不出来回 502。建议去掉头尾空白、去重。
 */
export const searchSuggestionsResult = async (
  rawKeyword: unknown,
  options: SessionMusicuOptions = {},
): Promise<NewRouteResult> => {
  try {
    const keyword = keywordOf(rawKeyword);
    const data = await anonymous(options).execute(searchSuggestions(keyword));
    const candidates = listOf(data.items).filter(
      (entry) => dictionaryOf(entry).type === SUGGESTION_TYPE,
    );
    if (!candidates.length) throw new QqApiError('not-found');
    const suggestions = [
      ...new Set(
        candidates
          .map((entry) => textOf(dictionaryOf(entry).hint)?.trim())
          .filter((hint): hint is string => hint !== undefined),
      ),
    ];
    if (!suggestions.length) throw new QqApiError('invalid-response');
    return okResult({ keyword, suggestions });
  } catch (error) {
    return failureResult('get-search-suggestions', error);
  }
};

// `/search/hot/categories`：按分类的热搜，要登录。实测（2026-11，带会话）：
// `HotkeyService.GetHotkeyAllBusinessForQQMusicMobile` 的 `map_business_hotkey` 以业务键分组，每组有
// `tabname_cn`、`tabname_en`、`show_order` 和 `vec_hotkey`；广告、功能入口、推荐词不交出。
// 每个词沿用 `/search/hot` 的格式。不同账号的分组数可能不同，只照实际回的给，不推断原因。
const hotCategories = (): MusicuDescriptor<Dictionary> => ({
  module: 'music.musicsearch.HotkeyService',
  method: 'GetHotkeyAllBusinessForQQMusicMobile',
  param: {
    from: '1,',
    start: '0',
    searchid: searchIdOf(),
    need_allhotkey: 1,
    need_reckey: 1,
    need_track_info: 1,
    default_key: [],
    history_query: [],
    custom_flag: '',
  },
  readOnly: true,
  operation: 'search.hot-categories',
  decode: decodeDictionary,
});

const orderOf = (value: unknown): number =>
  typeof value === 'number' && Number.isSafeInteger(value) ? value : Number.MAX_SAFE_INTEGER;

/** 没有分组回 200 空数组；有分组却一个关键字都读不出来回 502。 */
export const hotCategoriesResult = async (
  session: AuthSession | null,
  options: SessionMusicuOptions = {},
): Promise<NewRouteResult> => {
  try {
    if (!session) throw new QqApiError('auth-missing');
    const data = await createSessionMusicuClient(session, options).execute(hotCategories());
    const map = data.map_business_hotkey;
    if (map !== null && map !== undefined && !isDictionary(map))
      throw new QqApiError('invalid-response');
    const entries = Object.entries(isDictionary(map) ? map : {});
    const categories = entries
      .map(([key, value]) => {
        const group = dictionaryOf(value);
        const hotkeys = (Array.isArray(group.vec_hotkey) ? group.vec_hotkey : [])
          .map(toHotkey)
          .filter(Boolean);
        return hotkeys.length
          ? {
              order: orderOf(group.show_order),
              category: {
                key,
                name: textOf(group.tabname_cn) ?? '',
                nameEn: textOf(group.tabname_en) ?? '',
                hotkeys,
              },
            }
          : null;
      })
      .filter((item) => item !== null)
      .sort((a, b) => a.order - b.order || a.category.key.localeCompare(b.category.key))
      .map((item) => item.category);
    if (entries.length && !categories.length) throw new QqApiError('invalid-response');
    return okResult({ categories });
  } catch (error) {
    return failureResult('get-hot-search-categories', error);
  }
};
