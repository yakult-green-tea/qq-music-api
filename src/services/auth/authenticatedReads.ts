import { AuthCredentialRejectedError } from '../../util/authError';
import { GatewayCredentialConflictError } from '../../util/gatewayCredentialConflictError';
import { logger } from '../../util/logger';
import type { UpstreamPhase } from '../../util/safeError';
import {
  type Dictionary,
  dictionaryOf,
  identifierOf,
  isDictionary,
  numberOf,
  stringOf,
} from '../../util/values';
import {
  albumPicCoverUrlOf,
  firstSongAlbumCoverUrl,
  isOfficialPlaylistEntry,
} from '../songLists/officialPlaylist';
import {
  collectSongListPages,
  hasMoreOf,
  type PagingStopReason,
  SONG_LIST_MAX_PAGES,
  SONG_LIST_PAGE_SIZE,
  songIdOf,
  songsOf,
} from '../songLists/songListPages';
import { type AndroidDevice, credentialMusicId } from './androidDevice';
import { credentialFrom, sanitizePublicValue } from './credentialWire';
import type { AuthHttpClient } from './httpClient';
import { callMusicu, credentialCookieHeader, QqProtocolError } from './musicuProtocol';
import { withPlayCounts } from './playlistPlayCounts';
import { type AuthSession, type QqCredential } from './qrTypes';
import { WECHAT_LOGIN_TYPE } from './wechatLogin';

// src/services/auth/authenticatedReads.ts
// 从认证入口搬出的同一套实现；协议、状态与对外回包沿用原规则。

// 凭证寿命的计算搬到了 credentialExpiry.ts（静默续期也要用）；这里保留原来的导出名。
export {
  AUTH_TTL_MAX_MS,
  AUTH_TTL_MIN_MS,
  AUTH_TTL_MS,
  authSessionExpiryAt,
} from './credentialExpiry';

export const CREDENTIAL_REFRESH_SAFETY_CODES = new Set([1000, 104401, 104400]);

/** 上游用这几个安全码明确表示「这份凭证我不认」，与超时、限流、协议变动等失败区分开。 */
export const isCredentialRejection = (error: unknown): error is QqProtocolError =>
  error instanceof QqProtocolError &&
  // 收藏专辑的 CGI 只有一个 code，旧错误对象把它放进两个字段，不是两层网关冲突。
  (error.globalCode === 0 || error.phase === 'get-user-favorite-albums') &&
  error.upstreamCode !== undefined &&
  CREDENTIAL_REFRESH_SAFETY_CODES.has(error.upstreamCode);

/**
 * 在服务边界把「上游拒绝凭证」翻译成控制器层会回 401 的那一个错误。
 *
 * 只映射这三个已知安全码；其余上游失败保持原样，因此一次上游抖动不会把用户登出。上游的码是不透明
 * 数字，将来发现漏掉的码时在 `CREDENTIAL_REFRESH_SAFETY_CODES` 里补，映射逻辑不必改。
 */
export const withCredentialRejectionMapped = async <T>(operation: () => Promise<T>): Promise<T> => {
  try {
    return await operation();
  } catch (error) {
    if (
      error instanceof QqProtocolError &&
      error.phase !== 'get-user-favorite-albums' &&
      error.globalCode !== 0 &&
      error.httpStatus >= 200 &&
      error.httpStatus < 300 &&
      error.upstreamCode !== undefined &&
      CREDENTIAL_REFRESH_SAFETY_CODES.has(error.upstreamCode)
    )
      throw new GatewayCredentialConflictError(error);
    if (isCredentialRejection(error)) throw new AuthCredentialRejectedError(error.upstreamCode);
    throw error;
  }
};

export const getLoginUserWithCredential = async (
  http: AuthHttpClient,
  device: AndroidDevice,
  credential: QqCredential,
): Promise<Dictionary> =>
  dictionaryOf(
    sanitizePublicValue(
      await callMusicu(
        http,
        device,
        'get-login-user',
        'music.UserInfo.userInfoServer',
        'GetLoginUserInfo',
        {},
        credential,
      ),
    ),
  );

export const getLoginUser = async (http: AuthHttpClient, auth: AuthSession): Promise<Dictionary> =>
  getLoginUserWithCredential(http, auth.device, auth.credential);

/**
 * Builds the same public profile shape from the non-secret identity fields in a credential.
 *
 * The account id is the one `credentialMusicId` resolves, never the raw `musicid`: a WeChat
 * credential carries a placeholder there and keeps the real id in `str_musicid`, which is why
 * every upstream call this service makes already goes through that helper. Handing out the raw
 * field would publish an id the service itself refuses to key its own requests on.
 */
export const publicProfileFromCredential = (credential: QqCredential): Dictionary => {
  const musicId = credentialMusicId(credential);
  const nickname = stringOf(credential.nick) || stringOf(credential.nickname);
  const avatarUrl = stringOf(credential.logo) || stringOf(credential.avatarUrl);
  return {
    ...(musicId ? { musicid: musicId, str_musicid: musicId } : {}),
    ...(nickname ? { nickname, nick: nickname } : {}),
    ...(avatarUrl ? { avatarUrl } : {}),
  };
};

/**
 * `GetLoginUserInfo` never carries an account id. Measured against a real session, its top-level
 * keys are `errMsg` / `identify` / `info` / `celebrityInfo` plus operational slots, and every
 * account field lives under the nested `info` — there is no `musicid` or `uin` anywhere in it.
 * The credential-derived profile is therefore layered underneath as a default instead of only
 * standing in when the call fails. The two key sets are disjoint, so a successful reply still
 * wins on every field it does answer with.
 *
 * 这里曾经还有一条 WeChat 专用的兜底：上游用安全码拒绝凭证时改回传凭证里的字段。那让 `/login/status`
 * 报告「已登录」，而同一份凭证在其余 `/user/*` 上全部失败，用户卡在一个自己清不掉的状态里。拒绝现在
 * 直接往外抛，由服务边界映射成 401。
 */
export const getLoginProfile = async (
  http: AuthHttpClient,
  auth: AuthSession,
): Promise<Dictionary> => ({
  ...publicProfileFromCredential(auth.credential),
  ...(await getLoginUser(http, auth)),
});

const refreshCredentialAs = async (
  http: AuthHttpClient,
  device: AndroidDevice,
  credential: QqCredential,
  loginType: number,
): Promise<QqCredential> =>
  credentialFrom(
    await callMusicu(
      http,
      device,
      'credential-refresh',
      'music.login.LoginServer',
      'Login',
      {
        openid: stringOf(credential.openid),
        refresh_token: stringOf(credential.refresh_token),
        str_musicid: stringOf(credential.str_musicid) || String(credential.musicid),
        musickey: credential.musickey,
        unionid: stringOf(credential.unionid),
        refresh_key: stringOf(credential.refresh_key),
        loginMode: 2,
      },
      credential,
      { tmeLoginType: loginType },
    ),
    loginType,
  );

/** Refreshes a WeChat credential with the complete field set returned by its QR exchange. */
export const refreshWechatCredential = (
  http: AuthHttpClient,
  device: AndroidDevice,
  credential: QqCredential,
): Promise<QqCredential> => refreshCredentialAs(http, device, credential, WECHAT_LOGIN_TYPE);

/**
 * The stored silent refresh, for either channel: the login type is the one the credential already
 * carries, which is also what every authenticated read sends as `tmeLoginType`.
 */
export const refreshLoginCredential = (
  http: AuthHttpClient,
  device: AndroidDevice,
  credential: QqCredential,
): Promise<QqCredential> => refreshCredentialAs(http, device, credential, credential.loginType);

/** Refreshes the exchanged WeChat key once when the reference credential check requests it. */
export const validateWechatCredential = async (
  http: AuthHttpClient,
  device: AndroidDevice,
  credential: QqCredential,
): Promise<QqCredential> => {
  try {
    await getLoginUserWithCredential(http, device, credential);
    return credential;
  } catch (error) {
    if (
      !(error instanceof QqProtocolError) ||
      error.upstreamCode === undefined ||
      !CREDENTIAL_REFRESH_SAFETY_CODES.has(error.upstreamCode)
    )
      throw error;
  }

  const refreshed = await refreshWechatCredential(http, device, credential);
  logger.info('qq-auth.credential-refreshed', {
    loginChannel: 'wechat',
    credentialLoginType: refreshed.loginType,
    credentialKeys: Object.keys(refreshed).sort(),
    credentialKeyLength: refreshed.musickey.length,
  });
  return refreshed;
};

/** 收藏歌单最多读这么多条：上游一直说还有更多时，不能无限读下去。 */
export const FAVORITE_PLAYLIST_LIMIT = 1000;

export const FAVORITE_PLAYLIST_PAGE_SIZE = 100;

export { hasMoreOf, type PagingStopReason, songIdOf, songsOf };

/**
 * 没读完就停下时留一条诊断。停下是为了不无限读，不代表资料完整；这条日志说明为什么停、读到多少，
 * 只有数量，不记账号或歌单 id。
 */
export const logPagingStopped = (
  source: 'favorite-playlists' | 'song-list-detail',
  reason: PagingStopReason,
  pages: number,
  items: number,
  upstreamTotal: number | undefined,
): void => {
  logger.warn('qq-auth.paging-stopped', {
    source,
    reason,
    pages,
    items,
    ...(upstreamTotal !== undefined && Number.isSafeInteger(upstreamTotal)
      ? { upstreamTotal }
      : {}),
  });
};

/** 登录账号自己的 id：解析后的账号 id，或凭证里原样的两个字段（微信凭证的 `musicid` 是占位的 0）。 */
export const isOwnAccountId = (credential: QqCredential, uid: string): boolean =>
  [
    credentialMusicId(credential),
    identifierOf(credential.musicid),
    identifierOf(credential.str_musicid),
  ].includes(uid.trim());

export const playlistIdOf = (value: unknown): string => {
  const item = dictionaryOf(value);
  return identifierOf(item.tid ?? item.dissid ?? item.id ?? item.dirId ?? item.dirid);
};

/**
 * 第一轮（`favoriteOffset` 为 0）回自建＋收藏；从 `favoriteOffset` 接着读的那几轮只回收藏。
 * 每一轮最多读 1000 条收藏。读到上限时给 `nextFavoriteOffset`；空页或重复页停下时不给，
 * 因为接着读也只会重复同一件事。`total` 是真实总数：一轮就读完时是实际条目数；否则是自建数加上
 * 已知的收藏总数（上游报的总数与已经读到的数量取大者）。
 */
export const getPlaylists = async (
  http: AuthHttpClient,
  auth: AuthSession,
  favoriteOffset = 0,
  playCount = false,
): Promise<Dictionary> => {
  const created = await callMusicu(
    http,
    auth.device,
    'get-user-playlists',
    'music.musicasset.PlaylistBaseRead',
    'GetPlaylistByUin',
    { uin: credentialMusicId(auth.credential) },
    auth.credential,
  );
  let createdPlaylists: unknown[] = Array.isArray(created.v_playlist) ? created.v_playlist : [];
  let favoritePlaylists: unknown[] = [];
  const encryptedUin = stringOf(auth.credential.encryptUin);

  // 只有上游最后一页说“没有更多了”才算读完。读到上限、遇到空页、或整页都是读过的条目（上游不理
  // offset）时会提前停下，这时回 `bFinish: false`，控制器据此回 `more: true`，不把截断的列表说成完整的。
  let favoritesComplete = true;
  let favoritesKnown = 0;
  let nextFavoriteOffset: number | undefined;
  if (encryptedUin) {
    const seenFavorites = new Set<string>();
    let offset = favoriteOffset;
    let pages = 0;
    let unique = 0;
    let upstreamTotal: number | undefined;
    let stopReason: PagingStopReason | undefined;
    while (offset < favoriteOffset + FAVORITE_PLAYLIST_LIMIT) {
      const favoritePage = await callMusicu(
        http,
        auth.device,
        'get-user-favorite-playlists',
        'music.musicasset.PlaylistFavRead',
        'CgiGetPlaylistFavInfo',
        { uin: encryptedUin, offset, size: FAVORITE_PLAYLIST_PAGE_SIZE },
        auth.credential,
      );
      const pageItems = Array.isArray(favoritePage.v_list) ? favoritePage.v_list : [];
      pages += 1;
      upstreamTotal =
        favoritePage.total === undefined ? upstreamTotal : numberOf(favoritePage.total);
      favoritesComplete = !hasMoreOf(favoritePage);
      let fresh = 0;
      for (const item of pageItems) {
        const id = playlistIdOf(item);
        if (id && seenFavorites.has(id)) continue;
        if (id) seenFavorites.add(id);
        fresh += 1;
      }
      unique += fresh;
      favoritePlaylists.push(...pageItems.map(withOriginalCover));
      offset += pageItems.length;
      if (favoritesComplete) break;
      if (fresh === 0) {
        stopReason = pageItems.length === 0 ? 'empty-page' : 'repeated-page';
        break;
      }
    }
    if (!favoritesComplete) {
      logPagingStopped('favorite-playlists', stopReason ?? 'limit', pages, unique, upstreamTotal);
      if (stopReason === undefined) nextFavoriteOffset = offset;
    }
    const reported =
      upstreamTotal !== undefined && Number.isSafeInteger(upstreamTotal) ? upstreamTotal : 0;
    favoritesKnown = Math.max(reported, favoriteOffset + unique);
  }

  const firstRound = favoriteOffset === 0;
  // 只有调用方明确要播放数才多读旧接口；不带参数时请求与回包都和以前一样。
  let playCountComplete: boolean | undefined;
  if (playCount) {
    const counted = await withPlayCounts(
      http,
      auth,
      firstRound ? createdPlaylists : [],
      favoritePlaylists,
      playlistIdOf,
    );
    if (firstRound) createdPlaylists = counted.created;
    favoritePlaylists = counted.favorites;
    playCountComplete = counted.complete;
  }

  const seen = new Set<string>();
  const listed = firstRound ? [...createdPlaylists, ...favoritePlaylists] : favoritePlaylists;
  const playlists = listed.filter((value) => {
    const id = playlistIdOf(value);
    if (!id) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  return dictionaryOf(
    sanitizePublicValue({
      ...created,
      v_playlist: await withOfficialPlaylistCovers(http, auth, playlists),
      total:
        firstRound && favoritesComplete
          ? playlists.length
          : createdPlaylists.length + favoritesKnown,
      bFinish: favoritesComplete,
      ...(nextFavoriteOffset === undefined ? {} : { nextFavoriteOffset }),
      ...(playCountComplete === undefined ? {} : { playCountComplete }),
    }),
  );
};

/** 下游读封面的字段，与 `GetPlaylistByUin` 给自建歌单的同名。 */
export const PLAYLIST_COVER_FIELDS = ['bigpicUrl', 'picUrl', 'picurl', 'coverUrl'] as const;

/**
 * 收藏的他人歌单沿用歌单原本的封面：收藏者改不了封面，歌单主人设成什么（自定义图、第一首歌的
 * 专辑……）就显示什么。`CgiGetPlaylistFavInfo` 只给 `logo`（没有时看 `albumPicUrl`），下游读的是
 * `bigpicUrl` / `picUrl`，所以照自建歌单条目的字段名补上；两个都没有就原样，不编一个封面出来。
 *
 * 官方歌单另有规则（第一首歌的专辑图，见 `withOfficialPlaylistCovers`），这里跳过；已经带着
 * 封面字段的条目也原样。不发任何请求。
 */
export const withOriginalCover = (value: unknown): unknown => {
  if (!isDictionary(value) || isOfficialPlaylistEntry(value)) return value;
  if (PLAYLIST_COVER_FIELDS.some((field) => stringOf(value[field]).trim())) return value;
  const cover = stringOf(value.logo).trim() || stringOf(value.albumPicUrl).trim();
  return cover ? { ...value, bigpicUrl: cover, picUrl: cover } : value;
};

/** 一次 `/user/playlist` 最多为这么多张官方歌单读第一首歌补封面；每张多一次上游请求。 */
export const OFFICIAL_PLAYLIST_COVER_LIMIT = 20;

/**
 * 官方歌单（每日30首、算法歌单）的封面一律是第一首歌的专辑图，与 QQ 音乐客户端的显示一致。
 * 写进下游最先读的 `bigpicUrl` 与 `picUrl`（与自建歌单条目同名），`logo` / `albumPicUrl` 保留上游原值。
 *
 * 条目自带的 `albumPicUrl` 是专辑图时直接用它，不发请求；缺失或认不出来才为这一张多读一首歌，
 * 这类请求彼此并行、一次最多 20 张。读不到时条目原样返回：补封面失败不能让整个歌单列表跟着失败。
 */
export const withOfficialPlaylistCovers = async (
  http: AuthHttpClient,
  auth: AuthSession,
  playlists: unknown[],
): Promise<unknown[]> => {
  let remaining = OFFICIAL_PLAYLIST_COVER_LIMIT;
  return Promise.all(
    playlists.map(async (value) => {
      if (!isOfficialPlaylistEntry(value)) return value;
      const known = albumPicCoverUrlOf(value);
      if (known) return { ...dictionaryOf(value), bigpicUrl: known, picUrl: known };
      const disstid = positiveIdOf(dictionaryOf(value).tid);
      // 额度在第一个 await 之前扣，所以按列表顺序分配，与请求完成的先后无关
      if (!disstid || remaining <= 0) return value;
      remaining -= 1;
      try {
        const data = await withCredentialRejectionMapped(() =>
          getAuthenticatedSongListDetail(http, auth, disstid, 1),
        );
        const cover = firstSongAlbumCoverUrl(data.songlist);
        return cover ? { ...dictionaryOf(value), bigpicUrl: cover, picUrl: cover } : value;
      } catch (error) {
        logger.warn('qq-auth.official-playlist-cover-failed', {
          name: error instanceof Error ? error.name : 'Error',
          upstreamCode:
            error instanceof QqProtocolError || error instanceof AuthCredentialRejectedError
              ? error.upstreamCode
              : undefined,
        });
        return value;
      }
    }),
  );
};

/** 只接受正整数 id；`0`、负数、小数和带杂字的字符串一律不认，免得把它们送上游。 */
export const positiveIdOf = (value: unknown): number | undefined => {
  const text = identifierOf(value).trim();
  if (!/^\d+$/.test(text)) return undefined;
  const id = Number(text);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
};

export interface AuthenticatedSongListDetailOptions {
  /** 只读这么多首（夹在 1..1000），不续页。不给就按 `hasmore` 读完整张歌单。 */
  limit?: number;
}

/** 实测一页 1000 首可以一次读完 761 首的歌单；再多就续页。 */
export const AUTHENTICATED_SONG_LIST_PAGE_SIZE = SONG_LIST_PAGE_SIZE;

export const AUTHENTICATED_SONG_LIST_MAX_PAGES = SONG_LIST_MAX_PAGES;

/**
 * 带凭据读一张歌单。与 `getOwnedPlaylistSongs` 的 `CgiGetDiss` 不同，这里走 QQ 音乐客户端读算法歌单
 * 用的 `music.srfDissInfo.aiDissInfo/uniform_get_Dissinfo`：百万收藏这类按账号生成的歌单，匿名 CGI
 * 只回 `code: 10`，未登录调用这里回 `80120`，带上凭据才读得到（2026-10-09 实测）。
 *
 * 不给 `limit` 时按 `hasmore` 续读，但上游的 `hasmore` 不可全信：空页、读满 `total_song_num`、
 * 或读到第 10 页都会停。给了 `limit` 只读一页 —— 补封面只要第一首；算法歌单本来就无视 `song_num`，
 * 每次都回整张 50 首。
 */
export const getAuthenticatedSongListDetail = async (
  http: AuthHttpClient,
  auth: AuthSession,
  disstid: number,
  limit?: number,
): Promise<Dictionary> => {
  const readPage = async (songBegin: number, songNum: number): Promise<Dictionary> =>
    dictionaryOf(
      sanitizePublicValue(
        await callMusicu(
          http,
          auth.device,
          'get-song-list-detail',
          'music.srfDissInfo.aiDissInfo',
          'uniform_get_Dissinfo',
          {
            disstid,
            userinfo: 1,
            tag: 1,
            orderlist: 1,
            song_begin: songBegin,
            song_num: songNum,
            onlysonglist: 0,
            enc_host_uin: '',
          },
          auth.credential,
        ),
      ),
    );

  if (limit !== undefined && Number.isFinite(limit)) {
    return readPage(0, Math.min(AUTHENTICATED_SONG_LIST_PAGE_SIZE, Math.max(1, Math.floor(limit))));
  }

  const { first, songs, pages, complete, stopReason, upstreamTotal } = await collectSongListPages(
    readPage,
    AUTHENTICATED_SONG_LIST_PAGE_SIZE,
    AUTHENTICATED_SONG_LIST_MAX_PAGES,
  );
  // 回传的 hasmore 说的是这次读取的结果：读满总数或上游说没有更多才算读完；停在上限、空页或重复页
  // 时如实标成没读完，而不是照搬最后一页的原值。
  if (!complete && stopReason)
    logPagingStopped('song-list-detail', stopReason, pages, songs.length, upstreamTotal);
  return { ...first, songlist: songs, hasmore: complete ? 0 : 1 };
};

export const FAVORITE_ASSET_URL = 'https://c.y.qq.com/fav/fcgi-bin/fcg_get_profile_order_asset.fcg';

/** `2` selects favourite albums on this CGI; `3` selects favourite playlists. */
export const FAVORITE_ALBUM_REQUEST_TYPE = 2;

/**
 * Favourite albums are the one user collection the musicu RPC face does not answer with.
 * Measured 2026-08-08 against a live session that had two favourited albums:
 * `music.musicasset.AlbumFavRead/CgiGetAlbumFavInfo` does exist, but always replies `80000`
 * with a zero-filled struct — under 13 param shapes (`{}` included) and 4 client identities.
 * The code therefore never meant "no rows", and no sibling method answers either
 * (`CgiGetAlbumFavList` is `40000`, `music.musicasset.SingerFavRead` is `500003`).
 *
 * This legacy profile-asset CGI does answer, and it takes the native QR credential as-is: the
 * same call with `reqtype=3` returns exactly the favourite playlists musicu reports, and falls
 * to `4000` when the cookie is withheld — so it is reading the login state, not public data.
 *
 * `sin`/`ein` bound an inclusive range, not an offset and a count.
 */
export const getFavoriteAlbums = async (
  http: AuthHttpClient,
  auth: AuthSession,
  offset = 0,
  limit = 20,
): Promise<Dictionary> => {
  const safeOffset = Math.max(0, Math.floor(offset));
  const safeLimit = Math.min(100, Math.max(1, Math.floor(limit)));
  const response = await http.request<unknown>({
    url: FAVORITE_ASSET_URL,
    method: 'GET',
    params: {
      ct: 20,
      cid: 205360956,
      userid: credentialMusicId(auth.credential),
      reqtype: FAVORITE_ALBUM_REQUEST_TYPE,
      sin: safeOffset,
      ein: safeOffset + safeLimit - 1,
      format: 'json',
    },
    headers: {
      Referer: 'https://y.qq.com/',
      Cookie: credentialCookieHeader(auth.credential),
    },
  });
  const body = dictionaryOf(response.data);
  const code = numberOf(body.code) ?? 0;
  logger.info('qq-auth.upstream-result', {
    phase: 'get-user-favorite-albums',
    httpStatus: response.status,
    globalCode: code,
    upstreamCode: numberOf(body.subcode),
  });
  if (code !== 0)
    throw new QqProtocolError('get-user-favorite-albums', code, code, response.status);
  return dictionaryOf(sanitizePublicValue(dictionaryOf(body.data)));
};

export interface OwnedPlaylistSongsParams {
  /** The playlist's global id — the `tid` that `GetPlaylistByUin` lists. */
  disstid?: number | string;
  /** The directory number inside the account. `201` is the built-in 「我喜欢」. */
  dirid?: number | string;
  offset?: number;
  limit?: number;
}

export const LIKED_SONGS_DIRID = 201;

/**
 * Reads one playlist the logged-in user owns. Unlike the anonymous `fcg_ucc_getcdinfo_byids_cp`
 * behind `/getSongListDetail`, this call carries the credential, so a playlist the owner set to
 * 不公开 (`dirShow: 2`) still comes back with its songs instead of an empty `code: 0` shell.
 */
export const getOwnedPlaylistSongs = async (
  http: AuthHttpClient,
  auth: AuthSession,
  { disstid = 0, dirid = 0, offset = 0, limit = 100 }: OwnedPlaylistSongsParams = {},
  phase: UpstreamPhase = 'get-owned-playlist-songs',
): Promise<Dictionary> => {
  const encryptedUin = stringOf(auth.credential.encryptUin);
  if (!encryptedUin) throw new Error('Login credential is missing encryptUin');
  const safeOffset = Math.max(0, Math.floor(offset));
  const safeLimit = Math.min(100, Math.max(1, Math.floor(limit)));
  return dictionaryOf(
    sanitizePublicValue(
      await callMusicu(
        http,
        auth.device,
        phase,
        'music.srfDissInfo.DissInfo',
        'CgiGetDiss',
        {
          disstid: Number(disstid) || 0,
          dirid: Number(dirid) || 0,
          tag: true,
          song_begin: safeOffset,
          song_num: safeLimit,
          userinfo: true,
          orderlist: true,
          enc_host_uin: encryptedUin,
        },
        auth.credential,
      ),
    ),
  );
};

/** 「我喜欢」is `dirid: 201` of the same call; the phase name stays so existing log queries hold. */
export const getLikedSongs = (
  http: AuthHttpClient,
  auth: AuthSession,
  offset = 0,
  limit = 100,
): Promise<Dictionary> =>
  getOwnedPlaylistSongs(
    http,
    auth,
    { disstid: 0, dirid: LIKED_SONGS_DIRID, offset, limit },
    'get-user-liked-songs',
  );
