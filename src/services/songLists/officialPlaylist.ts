import {
  type Dictionary,
  dictionaryOf,
  identifierOf,
  isDictionary,
  numberOf,
  stringOf,
} from '../../util/values';

// src/services/songLists/officialPlaylist.ts
//
// QQ 音乐官方按账号生成的歌单（每日30首、百万收藏、歌手漫游……）的两条共用规则。
// 只依赖 `util/values`，保持运行时中立：Node 与 serverless 都从这里取同一套判定与改写。

/**
 * 官方歌单在 `/user/playlist` 的收藏条目里用 `dirType` 标出来（2026-10-09 真实账号实测）：
 * - `3`：算法歌单（百万收藏 `211111`、新歌推荐 `211207`、歌手漫游 `211192`）。匿名的
 *   `fcg_ucc_getcdinfo_byids_cp` 对它们只回 `code: 10`，要带登录凭据走 `uniform_get_Dissinfo`；
 * - `2`：每日30首。匿名 CGI 读得到，但同样是按账号每天生成的。
 * 普通收藏是 `0`，自建歌单的条目没有这个字段。只认这两个值，未知的类型一律当普通歌单。
 */
export const OFFICIAL_PLAYLIST_DIR_TYPES: ReadonlySet<number> = new Set([2, 3]);

export const isOfficialPlaylistEntry = (entry: unknown): boolean => {
  const raw = dictionaryOf(entry).dirType;
  // `numberOf(null)` 是 0、`numberOf('')` 也是 0，所以先挡掉空值，免得把缺字段读成某个类型
  if (raw === null || raw === undefined || raw === '') return false;
  const dirType = numberOf(raw);
  return dirType !== undefined && OFFICIAL_PLAYLIST_DIR_TYPES.has(dirType);
};

const ALBUM_MID_PATTERN = /^[0-9A-Za-z]+$/;

/** 与歌曲封面同一种写法（`T002` 是专辑图），下游已有的尺寸处理可以直接套用。 */
export const albumCoverUrlOf = (albumMid: unknown): string | undefined => {
  const mid = stringOf(albumMid).trim();
  return mid && ALBUM_MID_PATTERN.test(mid)
    ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${mid}.jpg?max_age=2592000`
    : undefined;
};

/** 专辑图地址的写法：`T002R{尺寸}M000{专辑 mid}.jpg`，后面可能跟 `?max_age=…`。 */
const ALBUM_COVER_URL_PATTERN = /\/T002R\d+x\d+M000([0-9A-Za-z]+)\.(?:jpg|jpeg|png|webp)(?:\?|$)/;

/** 从专辑图地址里取出专辑 mid；不是专辑图（比如日历图）或认不出来就返回 `undefined`。 */
export const albumMidOfCoverUrl = (url: unknown): string | undefined =>
  ALBUM_COVER_URL_PATTERN.exec(stringOf(url).trim())?.[1];

/**
 * 官方歌单的收藏条目自带的 `albumPicUrl`，只要它是一张专辑图，就是第一首歌的专辑图（2026-10-09
 * 真实账号实测）。拿它拼出和 `firstSongAlbumCoverUrl` 完全一样的封面地址，就不用再为每张官方歌单多读
 * 一次上游。
 *
 * 不看 `logo`：每日30首的 `logo` 是日历图，不是专辑图。
 */
export const albumPicCoverUrlOf = (entry: unknown): string | undefined =>
  albumCoverUrlOf(albumMidOfCoverUrl(dictionaryOf(entry).albumPicUrl));

/**
 * 官方歌单的封面就是第一首歌的专辑图，与 QQ 音乐客户端的显示一致。第一首没有专辑时不往后找，
 * 返回 `undefined`，由调用方保留原来的封面。
 */
export const firstSongAlbumCoverUrl = (songlist: unknown): string | undefined => {
  const first = Array.isArray(songlist) ? songlist[0] : undefined;
  return albumCoverUrlOf(dictionaryOf(dictionaryOf(first).album).mid);
};

const safeIntegerOf = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;

/** `numberOf(null)` 是 0；歌曲数缺失时要退回下一个来源，不能当成 0 首。 */
const countOf = (value: unknown): number | undefined =>
  value === null || value === undefined || value === '' ? undefined : numberOf(value);

/**
 * 把带凭据的 `uniform_get_Dissinfo` 结果改写成匿名 CGI 的回应形状（`cdlist[0]`），让
 * `/getSongListDetail` 的调用方不必区分歌单是从哪条路读到的。两边的歌曲条目本来就同形
 * （前者是后者字段的超集，实测顺序也一致），所以 `songlist` 原样沿用。
 *
 * 读不出歌单本体（没有 id、标题或歌曲）时返回 `null`，调用方据此保留匿名 CGI 的原始回应。
 */
export interface SongListDetailResponse {
  code: number;
  subcode: number;
  cdnum: number;
  realcdnum: number;
  cdlist: [Dictionary];
}

export interface SongListDetailResponseOptions {
  /**
   * 普通公开歌单（旧 CGI 回 4000 时匿名改读的结果）：封面先用歌单自己的 `picurl`，没有才用第一首的专辑图；
   * 公开（`dir_show` 为 1）的空歌单照常返回。不给就是官方歌单的写法，与原来完全相同。
   */
  publicPlaylist?: boolean;
}

export const toSongListDetailResponse = (
  data: unknown,
  options: SongListDetailResponseOptions = {},
): SongListDetailResponse | null => {
  if (!isDictionary(data)) return null;
  const dirinfo = dictionaryOf(data.dirinfo);
  const disstid = identifierOf(dirinfo.id);
  const title = stringOf(dirinfo.title).trim();
  const songlist = Array.isArray(data.songlist) ? data.songlist : [];
  const emptyAllowed = options.publicPlaylist === true && numberOf(dirinfo.dir_show) === 1;
  if (!disstid || !title || (songlist.length === 0 && !emptyAllowed)) return null;

  const total = countOf(data.total_song_num) ?? countOf(dirinfo.songnum) ?? songlist.length;
  const nickname = stringOf(dirinfo.host_nick);
  const playlistCover = stringOf(dirinfo.picurl).trim();
  const logo = options.publicPlaylist
    ? playlistCover || firstSongAlbumCoverUrl(songlist) || ''
    : (firstSongAlbumCoverUrl(songlist) ?? stringOf(dirinfo.picurl));
  return {
    code: 0,
    subcode: 0,
    cdnum: 1,
    realcdnum: 1,
    cdlist: [
      {
        disstid,
        dissname: stringOf(dirinfo.title),
        logo,
        desc: stringOf(dirinfo.desc),
        nickname,
        nick: nickname,
        dir_show: numberOf(dirinfo.dir_show) ?? 0,
        dirid: numberOf(dirinfo.dirid) ?? 0,
        song_begin: 0,
        cur_song_num: songlist.length,
        songnum: total,
        total_song_num: total,
        // 这次读取的结论：1 表示停在安全上限、空页或重复页，歌单还没读完。匿名 CGI 的回应不带这个字段。
        hasmore: data.hasmore === true || numberOf(data.hasmore) === 1 ? 1 : 0,
        // 播放数与建立者 id 沿用上游字段名；上游没给或类型不对就不补，缺失不当成 0。
        ...(safeIntegerOf(dirinfo.listennum) === undefined
          ? {}
          : { listennum: safeIntegerOf(dirinfo.listennum) }),
        // 普通公开歌单：旧 CGI 的 visitnum 与这里的 listennum 实测是同一个数（2026-11-24，14 张全部相等），
        // 照旧 CGI 的字段名补上，Folia 显示播放数读的是它。官方歌单没核对过，仍不补。
        ...(options.publicPlaylist && safeIntegerOf(dirinfo.listennum) !== undefined
          ? { visitnum: safeIntegerOf(dirinfo.listennum) }
          : {}),
        ...(safeIntegerOf(dirinfo.host_uin) === undefined
          ? {}
          : { uin: safeIntegerOf(dirinfo.host_uin) }),
        ...(stringOf(dirinfo.encrypt_uin) ? { encrypt_uin: stringOf(dirinfo.encrypt_uin) } : {}),
        songlist,
      },
    ],
  };
};
