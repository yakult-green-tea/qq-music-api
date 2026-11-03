import { QqApiError } from '../../protocol/errors';
import type { MusicuDescriptor } from '../../protocol/musicu';
import { type Dictionary, dictionaryOf, isDictionary, stringOf } from '../../util/values';
import { failureResult, type NewRouteResult, okResult } from './newRouteResult';
import { createSessionMusicuClient, type SessionMusicuOptions } from './sessionMusicu';

// src/services/recommend/catalog.ts
//
// `/recommend/categories`、`/recommend/category-playlists`、`/recommend/new-songs`、`/recommend/toplists`、
// `/recommend/toplist`、`/recommend/new-albums`：公开内容，一律匿名读，
// 带了会话也不用。Node 与 serverless 共用。实测（2026-10，匿名）：分类是 `get_hot_category`，分类歌单是
// `get_category_content`（`content.total_cnt`＋`v_item[].basic`），新歌是 `get_new_song_info`（`songlist` 与
// `track_info` 同形、`lanlist` 是地区）。

const DEFAULT_PAGE_SIZE = 20;
/** 网页和旧路由一次要 40 张都拿得到；更大的没有验证过。 */
const MAX_PAGE_SIZE = 40;
/** 上游的「最新」。 */
const DEFAULT_NEW_SONG_AREA = 5;

const positiveIdOf = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
// 榜单组的 id 从 0 起：上游第一组「巅峰榜」就是 0。榜单自己的 id 仍要正整数。
const groupIdOf = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

const countOf = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/** 必填的 id：只认纯数字的正整数。 */
const requiredIdOf = (raw: unknown): number => {
  const text = String(raw ?? '');
  const value = /^\d{1,15}$/.test(text) ? positiveIdOf(Number(text)) : undefined;
  if (value === undefined) throw new QqApiError('input');
  return value;
};

/** 分页参数和其他路由一样宽松：不是正整数就用默认值，超过上限就压到上限。 */
const pagingOf = (raw: unknown, fallback: number, max = Number.MAX_SAFE_INTEGER): number => {
  const value = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isSafeInteger(value) || value <= 0) return fallback;
  return Math.min(max, value);
};

const listOf = (value: unknown): unknown[] => {
  if (value !== null && value !== undefined && !Array.isArray(value))
    throw new QqApiError('invalid-response');
  return Array.isArray(value) ? value : [];
};

const decodeDictionary = (data: unknown): Dictionary => {
  if (!isDictionary(data)) throw new QqApiError('invalid-response');
  return data;
};

const anonymous = (options: SessionMusicuOptions) => createSessionMusicuClient(null, options);

// ---- 歌单分类 ----

const CATEGORIES: MusicuDescriptor<Dictionary> = {
  module: 'music.web_category_svr',
  method: 'get_hot_category',
  param: { qq: '' },
  readOnly: true,
  operation: 'recommend.categories',
  decode: decodeDictionary,
};

const toCategory = (entry: unknown): Dictionary | null => {
  const item = dictionaryOf(entry);
  const id = positiveIdOf(item.item_id);
  return id === undefined ? null : { id, name: stringOf(item.item_name) };
};

/** 没有可用分类的组跳过；上游给空清单回 422，给了组却一个分类都读不出来回 502。 */
export const playlistCategoriesResult = async (
  options: SessionMusicuOptions = {},
): Promise<NewRouteResult> => {
  try {
    const groups = listOf((await anonymous(options).execute(CATEGORIES)).category);
    if (!groups.length) throw new QqApiError('not-found');
    const readable = groups
      .map((entry) => {
        const group = dictionaryOf(entry);
        const categories = Array.isArray(group.items)
          ? group.items.map(toCategory).filter(Boolean)
          : [];
        const id = positiveIdOf(group.group_id);
        return categories.length && id !== undefined
          ? { id, name: stringOf(group.group_name), categories }
          : null;
      })
      .filter(Boolean);
    if (!readable.length) throw new QqApiError('invalid-response');
    return okResult({ groups: readable });
  } catch (error) {
    return failureResult('get-playlist-categories', error);
  }
};

// ---- 分类歌单 ----

const categoryPlaylists = (
  id: number,
  page: number,
  size: number,
): MusicuDescriptor<Dictionary> => ({
  module: 'music.playlist.PlayListCategory',
  method: 'get_category_content',
  param: { caller: '0', category_id: id, page: page - 1, size, use_page: 1 },
  readOnly: true,
  operation: 'recommend.category-playlists',
  decode: decodeDictionary,
});

const creatorOf = (creator: Dictionary): Dictionary => {
  const uin =
    typeof creator.uin === 'number' && Number.isSafeInteger(creator.uin)
      ? String(creator.uin)
      : typeof creator.uin === 'string' && /^\d+$/.test(creator.uin)
        ? creator.uin
        : undefined;
  return {
    ...(uin === undefined ? {} : { uin }),
    ...Object.fromEntries(
      ['nick', 'avatar']
        .filter((key) => typeof creator[key] === 'string' && creator[key] !== '')
        .map((key) => [key, creator[key]]),
    ),
  };
};

/** 和 `/recommend/playlists` 同一套字段名；没有可用 tid 的跳过，数字缺失就不给。 */
const toPlaylist = (entry: unknown): Dictionary | null => {
  const item = dictionaryOf(dictionaryOf(entry).basic);
  const tid = positiveIdOf(item.tid);
  if (tid === undefined) return null;
  const playCount = countOf(item.play_cnt);
  const cover = dictionaryOf(item.cover);
  return {
    tid,
    title: stringOf(item.title),
    desc: stringOf(item.desc),
    picurl:
      [cover.big_url, cover.medium_url, cover.small_url, cover.default_url]
        .map(stringOf)
        .find((url) => url !== '') ?? '',
    ...(playCount === undefined ? {} : { play_cnt: playCount }),
    creator: creatorOf(dictionaryOf(item.creator)),
  };
};

/**
 * 对外 page 从 1 开始，上游 page 减 1；total 只看 content.total_cnt，不混用其他来源的 total。
 * 空页回 422；给了条目却一张都读不出来回 502。
 */
export const categoryPlaylistsResult = async (
  raw: { id?: unknown; page?: unknown; limit?: unknown },
  options: SessionMusicuOptions = {},
): Promise<NewRouteResult> => {
  try {
    const id = requiredIdOf(raw.id);
    const page = pagingOf(raw.page, 1);
    const size = pagingOf(raw.limit, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const data = await anonymous({ ...options, anonymousUin: 0 }).execute(
      categoryPlaylists(id, page, size),
    );
    if (typeof data.retcode !== 'number' || !Number.isSafeInteger(data.retcode))
      throw new QqApiError('invalid-response');
    if (data.retcode !== 0) throw new QqApiError('upstream-business');
    if (!isDictionary(data.content) || !Array.isArray(data.content.v_item))
      throw new QqApiError('invalid-response');
    const entries = listOf(data.content.v_item);
    if (!entries.length) throw new QqApiError('not-found');
    const playlists = entries.map(toPlaylist).filter(Boolean);
    if (!playlists.length) throw new QqApiError('invalid-response');
    const total = countOf(data.content.total_cnt);
    return okResult({
      playlists,
      ...(total === undefined ? {} : { total }),
      more: total !== undefined && page * size < total,
    });
  } catch (error) {
    return failureResult('get-category-playlists', error);
  }
};

// ---- 新歌速递 ----

const newSongs = (area: number): MusicuDescriptor<Dictionary> => ({
  module: 'newsong.NewSongServer',
  method: 'get_new_song_info',
  param: { type: area },
  readOnly: true,
  operation: 'recommend.new-songs',
  decode: decodeDictionary,
});

const toArea = (entry: unknown): Dictionary | null => {
  const item = dictionaryOf(entry);
  const id = positiveIdOf(item.type);
  return id === undefined ? null : { id, name: stringOf(item.name) };
};

/** `area` 不给就是「最新」；给了就要是正整数。歌曲条目原样交出去；没有歌回 422。 */
export const newSongsResult = async (
  rawArea: unknown,
  options: SessionMusicuOptions = {},
): Promise<NewRouteResult> => {
  try {
    const area =
      rawArea === undefined || rawArea === null || rawArea === ''
        ? DEFAULT_NEW_SONG_AREA
        : requiredIdOf(rawArea);
    const data = await anonymous(options).execute(newSongs(area));
    const songs = listOf(data.songlist);
    if (!songs.length) throw new QqApiError('not-found');
    const areas = Array.isArray(data.lanlist) ? data.lanlist.map(toArea).filter(Boolean) : [];
    return okResult({ area: positiveIdOf(data.type) ?? area, songs, areas });
  } catch (error) {
    return failureResult('get-new-songs', error);
  }
};

// ---- 排行榜 ----
//
// 实测（2026-10，官方网页登录与匿名都读得到）：榜单清单是 `ToplistInfoServer.GetAll`（`group[].toplist[]`），
// 单榜是 `GetDetail`，参数要全小写的 `topid`（大写的 `topId` 会被忽略）。`period` 照抄清单里那个榜的值
// （日榜 `YYYY-MM-DD`、周榜 `YYYY_NN`），送空字符串时上游给最新一期。`songInfoList` 与 `track_info` 同形。

const TOPLIST_PAGE_SIZE = 20;
/** 榜单一般 100 首；一次要整榜还没有实测过更大的。 */
const MAX_TOPLIST_PAGE_SIZE = 100;
const PERIOD_PATTERN = /^[0-9_-]{0,20}$/;

const TOPLISTS: MusicuDescriptor<Dictionary> = {
  module: 'musicToplist.ToplistInfoServer',
  method: 'GetAll',
  param: {},
  readOnly: true,
  operation: 'recommend.toplists',
  decode: decodeDictionary,
};

const toplistDetail = (
  id: number,
  offset: number,
  size: number,
  period: string,
): MusicuDescriptor<Dictionary> => ({
  module: 'musicToplist.ToplistInfoServer',
  method: 'GetDetail',
  param: { topid: id, offset, num: size, period },
  readOnly: true,
  operation: 'recommend.toplist',
  decode: decodeDictionary,
});

const textOf = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

/** 榜单的公开资料；缺字段或型别不对的就不给。 */
const toChartInfo = (entry: unknown): Dictionary | null => {
  const item = dictionaryOf(entry);
  const id = positiveIdOf(item.topId);
  if (id === undefined) return null;
  const optional: Array<[string, unknown]> = [
    ['intro', textOf(item.intro)],
    ['period', textOf(item.period)],
    ['updateType', countOf(item.updateType)],
    ['updateTime', textOf(item.updateTime)],
    ['total', countOf(item.totalNum)],
    ['listenNum', countOf(item.listenNum)],
    ['cover', textOf(item.headPicUrl) ?? textOf(item.frontPicUrl) ?? textOf(item.musichallPicUrl)],
  ];
  return {
    id,
    title: stringOf(item.title),
    ...Object.fromEntries(optional.filter(([, value]) => value !== undefined)),
  };
};

const toPreview = (entry: unknown): Dictionary | null => {
  const item = dictionaryOf(entry);
  const rank = positiveIdOf(item.rank);
  return rank === undefined
    ? null
    : { rank, title: stringOf(item.title), singer: stringOf(item.singerName) };
};

/** 清单里没有可用 id 的榜跳过，一个榜都没有的组也跳过；上游给空清单回 422，读不出任何榜回 502。 */
export const toplistsResult = async (
  options: SessionMusicuOptions = {},
): Promise<NewRouteResult> => {
  try {
    const groups = listOf((await anonymous(options).execute(TOPLISTS)).group);
    if (!groups.length) throw new QqApiError('not-found');
    const readable = groups
      .map((entry) => {
        const group = dictionaryOf(entry);
        const toplists = (Array.isArray(group.toplist) ? group.toplist : [])
          .map((item) => {
            const info = toChartInfo(item);
            if (!info) return null;
            const songs = dictionaryOf(item).song;
            return {
              ...info,
              preview: Array.isArray(songs) ? songs.map(toPreview).filter(Boolean) : [],
            };
          })
          .filter(Boolean);
        const id = groupIdOf(group.groupId);
        return toplists.length && id !== undefined
          ? { id, name: stringOf(group.groupName), toplists }
          : null;
      })
      .filter(Boolean);
    if (!readable.length) throw new QqApiError('invalid-response');
    return okResult({ groups: readable });
  } catch (error) {
    return failureResult('get-toplists', error);
  }
};

const offsetOf = (raw: unknown): number => {
  const value = Number.parseInt(String(raw ?? ''), 10);
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
};

/** 单榜的歌：`songs` 保持上游原来的格式；`total` 只在上游给的是正常整数时才有，没有就不报还有下一页。 */
export const toplistSongsResult = async (
  query: { id?: unknown; period?: unknown; offset?: unknown; limit?: unknown },
  options: SessionMusicuOptions = {},
): Promise<NewRouteResult> => {
  try {
    const id = requiredIdOf(query.id);
    const period = query.period === undefined || query.period === null ? '' : String(query.period);
    if (!PERIOD_PATTERN.test(period)) throw new QqApiError('input');
    const offset = offsetOf(query.offset);
    const size = pagingOf(query.limit, TOPLIST_PAGE_SIZE, MAX_TOPLIST_PAGE_SIZE);
    const data = await anonymous(options).execute(toplistDetail(id, offset, size, period));
    if (!isDictionary(data.data)) throw new QqApiError('invalid-response');
    const songs = listOf(data.songInfoList);
    if (!songs.length) throw new QqApiError('not-found');
    const info = toChartInfo(data.data);
    if (!info) throw new QqApiError('invalid-response');
    const count = countOf(info.total);
    // 可选元数据读不到时不改变原有的歌曲、分页与错误结果，也不增加上游请求。
    const ranks = Array.isArray(data.data.song)
      ? data.data.song.flatMap((entry: unknown) => {
          const item = dictionaryOf(entry);
          const songId = positiveIdOf(item.songId);
          const rank = positiveIdOf(item.rank);
          if (songId === undefined || rank === undefined) return [];
          const rankType = countOf(item.rankType);
          return [
            {
              songId,
              rank,
              ...(rankType === undefined ? {} : { rankType }),
              ...(typeof item.rankValue === 'string' ? { rankValue: item.rankValue } : {}),
            },
          ];
        })
      : undefined;
    const history = dictionaryOf(data.data.history);
    const hasHistory = Array.isArray(history.year) && Array.isArray(history.subPeriod);
    return okResult({
      toplist: info,
      songs,
      ...(count === undefined ? {} : { total: count }),
      more: count !== undefined && offset + songs.length < count,
      ...(ranks === undefined || !ranks.length ? {} : { ranks }),
      ...(hasHistory ? { history: { year: history.year, subPeriod: history.subPeriod } } : {}),
    });
  } catch (error) {
    return failureResult('get-toplist', error);
  }
};

// ---- 新碟上架 ----
//
// 实测（2026-10，官方网页登录与匿名都读得到）：地区清单是 `get_new_album_area`（无参数，`area[]`，id 1–5，
// 没有「最新」），专辑是 `get_new_album_info { area, sin: 0, num, start }`，`sin` 一律 0，翻页用 `start`。
// 两支放在同一次请求里；地区清单读不到不影响专辑。专辑摊平成和收藏专辑一样好用的字段。

const DEFAULT_NEW_ALBUM_AREA = 1;
const NEW_ALBUM_PAGE_SIZE = 20;
/** 网页一次要 20 张；40 张在实网冒烟里验过。 */
const MAX_NEW_ALBUM_PAGE_SIZE = 40;

const NEW_ALBUM_AREAS: MusicuDescriptor<Dictionary> = {
  module: 'newalbum.NewAlbumServer',
  method: 'get_new_album_area',
  param: {},
  readOnly: true,
  operation: 'recommend.new-album-areas',
  decode: decodeDictionary,
};

const newAlbums = (area: number, start: number, size: number): MusicuDescriptor<Dictionary> => ({
  module: 'newalbum.NewAlbumServer',
  method: 'get_new_album_info',
  param: { area, sin: 0, start, num: size },
  readOnly: true,
  operation: 'recommend.new-albums',
  decode: decodeDictionary,
});

const toAlbumSinger = (entry: unknown): Dictionary | null => {
  const singer = dictionaryOf(entry);
  const mid = textOf(singer.mid);
  return mid === undefined ? null : { mid, name: stringOf(singer.name) };
};

const toNewAlbum = (entry: unknown): Dictionary | null => {
  const item = dictionaryOf(entry);
  const mid = textOf(item.mid);
  if (mid === undefined) return null;
  const optional: Array<[string, unknown]> = [
    ['id', positiveIdOf(item.id)],
    ['publishDate', textOf(item.release_time)],
    ['company', textOf(dictionaryOf(item.company).name)],
    ['trackCount', countOf(dictionaryOf(item.ex).track_nums)],
  ];
  return {
    mid,
    name: stringOf(item.name),
    singers: Array.isArray(item.singers) ? item.singers.map(toAlbumSinger).filter(Boolean) : [],
    ...Object.fromEntries(optional.filter(([, value]) => value !== undefined)),
  };
};

const toAlbumArea = (entry: unknown): Dictionary | null => {
  const item = dictionaryOf(entry);
  const id = positiveIdOf(item.id);
  return id === undefined ? null : { id, name: stringOf(item.name) };
};

/** 没有专辑回 422，给了专辑却一张都读不出来回 502；`total` 不是正常整数时不给，也不报还有下一页。 */
export const newAlbumsResult = async (
  query: { area?: unknown; offset?: unknown; limit?: unknown },
  options: SessionMusicuOptions = {},
): Promise<NewRouteResult> => {
  try {
    const area =
      query.area === undefined || query.area === null || query.area === ''
        ? DEFAULT_NEW_ALBUM_AREA
        : requiredIdOf(query.area);
    const start = offsetOf(query.offset);
    const size = pagingOf(query.limit, NEW_ALBUM_PAGE_SIZE, MAX_NEW_ALBUM_PAGE_SIZE);
    const [areaResult, albumResult] = await anonymous(options).executeBatch([
      NEW_ALBUM_AREAS,
      newAlbums(area, start, size),
    ]);
    if (!albumResult.ok) throw albumResult.error;
    const data = albumResult.data as Dictionary;
    const entries = listOf(data.albums);
    if (!entries.length) throw new QqApiError('not-found');
    const albums = entries.map(toNewAlbum).filter(Boolean);
    if (!albums.length) throw new QqApiError('invalid-response');
    const areaList = areaResult.ok ? (areaResult.data as Dictionary).area : undefined;
    const areas = Array.isArray(areaList) ? areaList.map(toAlbumArea).filter(Boolean) : [];
    const total = countOf(data.total);
    return okResult({
      area,
      albums,
      areas,
      ...(total === undefined ? {} : { total }),
      more: total !== undefined && start + entries.length < total,
    });
  } catch (error) {
    return failureResult('get-new-albums', error);
  }
};
