import { LITE_ANONYMOUS_COMM, LITE_ANONYMOUS_HEADERS } from '../../protocol/clientProfiles';
import { QqApiError } from '../../protocol/errors';
import { createMusicuClient, type MusicuDescriptor } from '../../protocol/musicu';
import { createFetchTransport } from '../../transport/fetch';
import { type Dictionary, isDictionary } from '../../util/values';
import type { AuthSession } from '../auth/qrLogin';
import { failureResult, type NewRouteResult, okResult } from '../recommend/newRouteResult';
import { createSessionMusicuClient, type SessionMusicuOptions } from '../recommend/sessionMusicu';

// src/services/search/search.ts
//
// `/search`：按关键字搜歌曲、专辑、歌单、歌手。Node 与 serverless 共用。
// 实测（2026-10）：精简版搜索方法用不签名的 musicu 就能读。有会话时带会话，四种类型都有结果；
// 没有会话时用精简版的匿名身份，四种类型都有结果（搜歌要送 7，见下）。
// 单项码不是 0 时清单也是空的，一律当失败，不当成「没有结果」。

export const SEARCH_TYPES = ['song', 'album', 'playlist', 'singer'] as const;
export type SearchType = (typeof SEARCH_TYPES)[number];

const SEARCH_TYPE_CODES: Record<SearchType, number> = { song: 0, singer: 1, album: 2, playlist: 3 };
/**
 * 不登录搜歌送 7：2026-10 实测上游已经不认 0，不登录时一律回 2001，送 7 就有结果、条目格式相同。
 * 带会话时 0 一直搜得到，7 还没在带会话时验过，所以照旧送 0。
 */
const ANONYMOUS_SONG_SEARCH_TYPE = 7;
/** 精简版把各类型的条目直接放在 `body` 下的数组里，歌手那组没有 `item_` 前缀。 */
const LIST_KEYS: Record<SearchType, string> = {
  song: 'item_song',
  singer: 'singer',
  album: 'item_album',
  playlist: 'item_songlist',
};
const REMOTE_PLACE = 'search.android.keyboard';

/** 精简版客户端的匿名身份放在 protocol/clientProfiles；这两个名字留给原来的引用。 */
export const ANONYMOUS_LITE_COMM = LITE_ANONYMOUS_COMM;
export const ANONYMOUS_LITE_HEADERS = LITE_ANONYMOUS_HEADERS;

const DEFAULT_LIMIT = 10;
/** 实测验证过一页 10 与 20 条；更大的没有验证过。 */
const MAX_LIMIT = 20;
/** 精简版客户端最多送 60 个字。 */
const MAX_KEYWORD_LENGTH = 60;

/** 不给类型就是歌曲；给了不认识的值算参数错误。 */
export const searchTypeOf = (raw: unknown): SearchType => {
  if (raw === undefined || raw === null || raw === '') return 'song';
  const type = SEARCH_TYPES.find((value) => value === raw);
  if (type === undefined) throw new QqApiError('input');
  return type;
};

export const keywordOf = (raw: unknown): string => {
  const keyword = typeof raw === 'string' ? raw.trim() : '';
  if (!keyword || keyword.length > MAX_KEYWORD_LENGTH) throw new QqApiError('input');
  return keyword;
};

/** 分页参数和其他路由一样宽松：不是正整数就用默认值，超过上限就压到上限。 */
const pagingOf = (raw: unknown, fallback: number, max = Number.MAX_SAFE_INTEGER): number => {
  const value = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isSafeInteger(value) || value <= 0) return fallback;
  return Math.min(max, value);
};

const countOf = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/** 每次搜索带一个随机数字串；不需要密码学强度，也不能依赖 `node:*`。 */
export const searchIdOf = (): string =>
  `${Math.floor(Math.random() * 9 + 1)}${Array.from({ length: 17 }, () =>
    Math.floor(Math.random() * 10),
  ).join('')}`;

interface SearchData {
  items: Dictionary[];
  total?: number;
  more: boolean;
}

const decoderFor =
  (type: SearchType) =>
  (data: unknown): SearchData => {
    if (!isDictionary(data) || !isDictionary(data.body) || !isDictionary(data.meta))
      throw new QqApiError('invalid-response');
    // 实测成功时内层 code 是 0；非 0 的意思没有分离，不当成功。
    if (data.code !== undefined && data.code !== 0) throw new QqApiError('invalid-response');
    const list = data.body[LIST_KEYS[type]];
    if (!Array.isArray(list)) throw new QqApiError('invalid-response');
    const items = list.filter(isDictionary);
    if (items.length < list.length) throw new QqApiError('invalid-response');
    const { nextpage } = data.meta;
    return {
      items,
      total: countOf(data.meta.sum),
      more: typeof nextpage === 'number' && Number.isSafeInteger(nextpage) && nextpage > 0,
    };
  };

const searchRequest = (
  type: SearchType,
  keyword: string,
  page: number,
  limit: number,
  anonymous: boolean,
): MusicuDescriptor<SearchData> => ({
  module: 'music.search.SearchCgiService',
  method: 'DoSearchForQQMusicLite',
  param: {
    search_id: searchIdOf(),
    remoteplace: REMOTE_PLACE,
    query: keyword,
    search_type:
      anonymous && type === 'song' ? ANONYMOUS_SONG_SEARCH_TYPE : SEARCH_TYPE_CODES[type],
    num_per_page: limit,
    page_num: page,
    highlight: 0,
    nqc_flag: 0,
    page_id: 1,
    grp: 1,
  },
  readOnly: true,
  operation: 'search',
  decode: decoderFor(type),
});

const clientFor = (session: AuthSession | null, options: SessionMusicuOptions) =>
  session
    ? createSessionMusicuClient(session, options)
    : createMusicuClient({
        http: createFetchTransport(options.fetcher),
        comm: ANONYMOUS_LITE_COMM,
        headers: ANONYMOUS_LITE_HEADERS,
      });

/**
 * 条目原样交出去（保留各种 MID），由调用方自己整理。有会话就带会话，没有就匿名搜。
 * 搜不到回 200 加空清单；`total` 取上游 `meta.sum`，`more` 只看上游的下一页标记。
 */
export const searchResult = async (
  raw: { keyword?: unknown; type?: unknown; page?: unknown; limit?: unknown },
  session: AuthSession | null,
  options: SessionMusicuOptions = {},
): Promise<NewRouteResult> => {
  try {
    const type = searchTypeOf(raw.type);
    const keyword = keywordOf(raw.keyword);
    const page = pagingOf(raw.page, 1);
    const limit = pagingOf(raw.limit, DEFAULT_LIMIT, MAX_LIMIT);
    const data = await clientFor(session, options).execute(
      searchRequest(type, keyword, page, limit, session === null),
    );
    return okResult({
      type,
      page,
      limit,
      ...(data.total === undefined ? {} : { total: data.total }),
      more: data.more,
      items: data.items,
    });
  } catch (error) {
    return failureResult('search', error);
  }
};
