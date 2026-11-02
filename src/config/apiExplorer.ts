import { routeManifest } from '../routes/manifest';

export type ApiExplorerMethod = 'GET' | 'POST';

export type ApiExplorerInputType = 'text' | 'number' | 'boolean' | 'textarea';

export interface ApiExplorerField {
  key: string;
  label: string;
  required?: boolean;
  placeholder?: string;
  description?: string;
  defaultValue?: string | number | boolean;
  inputType?: ApiExplorerInputType;
}

export interface ApiExplorerEndpoint {
  id: string;
  name: string;
  category: string;
  description: string;
  method: ApiExplorerMethod;
  routePath: string;
  path: string;
  pathParams?: ApiExplorerField[];
  queryParams?: ApiExplorerField[];
  bodyExample?: Record<string, unknown>;
  bodyDescription?: string;
}

export interface ApiExplorerMetadata {
  title: string;
  description: string;
  endpoints: ApiExplorerEndpoint[];
}

export const API_EXPLORER_ROUTE_PATH = '/explorer';
export const API_EXPLORER_INDEX_PATH = '/explorer/index.html';
export const API_EXPLORER_METADATA_PATH = '/explorer/metadata';

export interface ApiExplorerBaseRoute {
  name: string;
  method: ApiExplorerMethod;
  routePath: string;
  category: string;
}

const humanizeFieldLabel = (value: string): string =>
  value
    .split('_')
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(' ');

export const createApiExplorerId = (name: string): string =>
  name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/_/g, '-')
    .toLowerCase();

export const stripRouteParams = (routePath: string): string => {
  const strippedPath = routePath.replace(/\/:[A-Za-z0-9_]+\??/g, '');
  return strippedPath || '/';
};

export const extractRouteParams = (routePath: string): ApiExplorerField[] => {
  const matches = [...routePath.matchAll(/:([A-Za-z0-9_]+)(\?)?/g)];

  return matches.map((match) => {
    const key = match[1];
    const isOptional = match[2] === '?';

    return {
      key,
      label: humanizeFieldLabel(key),
      required: !isOptional,
      placeholder: key,
      description: `Route parameter: ${key}`,
    };
  });
};

// 路由列表跟着 manifest 走，顺序一样；说明和参数写在下面的 overrides。
export const apiExplorerBaseRoutes: ApiExplorerBaseRoute[] = routeManifest.map(
  ({ name, method, path, category }) => ({ name, method, routePath: path, category }),
);

export const apiExplorerOverrides: Record<string, Partial<ApiExplorerEndpoint>> = {
  songFavCount: {
    description:
      '匿名读取歌曲收藏数。重复 id 只查询一次，items 保留输入顺序和重复项；缺值为 null，整批无数据回 422。',
    queryParams: [
      {
        key: 'ids',
        label: '歌曲数字 id（1–20 项）',
        required: true,
        placeholder: '90001,90002,90001',
        description: '逗号分隔的安全正整数 songid，不接受 MID；输入项数在去重前计数。',
      },
    ],
  },
  searchUsers: {
    description:
      '带会话搜索用户，users 保留上游条目原格式；total 不可靠时为 null，空页回 422。Serverless 需要会话密钥。',
    queryParams: [
      {
        key: 'keyword',
        label: '关键词',
        required: true,
        placeholder: 'fixture-user',
        description: '去掉首尾空格后为 1–60 个字符。',
      },
      { key: 'page', label: '页码（从 1 开始）', defaultValue: 1, inputType: 'number' },
      { key: 'limit', label: '数量（1–20）', defaultValue: 10, inputType: 'number' },
    ],
  },
  songVersions: {
    description: '匿名读取歌曲其他版本，id 和 mid 必须二选一；songs 保留原格式，空列表回 422。',
    queryParams: [
      {
        key: 'id',
        label: '歌曲数字 id（二选一）',
        placeholder: '90001',
        description: '安全正整数 songid。',
      },
      {
        key: 'mid',
        label: '歌曲 MID（二选一）',
        placeholder: 'fixtureVersionA',
        description: '1–64 个字母或数字。',
      },
    ],
  },
  userMusicGene: {
    description:
      '带会话读取本人的音乐基因，无业务参数。profile 保留原始结构，IsVisitAccount 保持数字；上游非零业务码回 502 并保留 upstreamCode。Serverless 需要会话密钥。',
    queryParams: [],
  },
  searchMatch: {
    description: '读取歌曲、歌手、专辑和 MV 的直接命中，不需要登录。',
    queryParams: [
      {
        key: 'keyword',
        label: '关键词',
        required: true,
        description: '去掉头尾空格后为 1–60 个字符。',
      },
    ],
  },
  allPlaylistCategories: {
    description: '读取完整歌单分类字典，包含可用标记和排序选项；与热门分类分开。',
    queryParams: [],
  },
  sortedCategoryPlaylists: {
    description: '按分类、排序与偏移量读取歌单；使用旧 CGI 数据源，不与其他分类歌单的分页混用。',
    queryParams: [
      { key: 'id', label: '分类编号', defaultValue: 10000000 },
      { key: 'offset', label: '起始位置', defaultValue: 0 },
      { key: 'limit', label: '数量（1–60）', defaultValue: 20 },
      { key: 'sortId', label: '上游排序编号', defaultValue: 5 },
    ],
  },
  radioCategories: {
    description: '匿名读取电台分类；不提供个人最近记录，也不改变登录后电台接口。',
    queryParams: [],
  },
  commentList: {
    description:
      '匿名读取资源评论与回复；数字协议参数不推断资源类型。续页必须带上一次的 nextCursor。',
    queryParams: [
      { key: 'id', label: '资源编号', required: true },
      { key: 'page', label: '页号（从 0 开始）', defaultValue: 0 },
      { key: 'limit', label: '数量（1–50）', defaultValue: 25 },
      { key: 'cursor', label: '上一页 nextCursor' },
      { key: 'biztype', label: '上游业务类型', defaultValue: 1 },
      { key: 'cid', label: '上游接口编号', defaultValue: 205360772 },
      { key: 'cmd', label: '上游命令', defaultValue: 8 },
      { key: 'reqtype', label: '上游请求类型', defaultValue: 2 },
    ],
  },
  songBatch: {
    description:
      '一次匿名请求读取 1–20 首歌曲详情；保留输入顺序和重复项，失败按项返回，不自动重试。',
    bodyExample: { songs: [{ mid: 'FixtureSongA1', id: 90001 }, { mid: 'FixtureSongB2' }] },
    bodyDescription: 'songs 必填，1–20 项；mid 为字母或数字，id 可省略。',
  },
  playlistRename: {
    description:
      'Rename your own ordinary playlist. The editor read preserves description, tag identifiers, exact cover URL including its query and visibility (only 1 or 2). Non-empty secondary covers remain unsupported until preservation is verified. One write, followed by a matching read; uncertain outcomes must not be retried blindly.',
    bodyExample: { tid: '70001', name: '新的歌单名称' },
  },
  playlistCreate: {
    description:
      'Create a playlist with a name of up to 20 characters. Writes are never retried. The name and identifiers are checked through the owned list after writing; upstream write-response names may be garbled. If verification fails, retryable is false and writeAttempted/verification report the uncertain outcome.',
    bodyExample: { name: '示例歌单' },
  },
  playlistDelete: {
    description:
      'Delete your own ordinary playlist by tid. The server resolves its directory from your owned list, rejects protected/system directories, sends one delete, checks matching identifiers and reads back absence. No automatic retry and no promise that recovery is possible.',
    bodyExample: { tid: '70001' },
  },
  playlistSubscribe: {
    description:
      'Subscribe or unsubscribe a playlist for the signed-in account. Writes are never automatically retried. Success requires result 0 and an empty failure list.',
    bodyExample: { tid: '70001', subscribed: true },
  },
  songLike: {
    description:
      'Like or unlike a catalog song for the signed-in account. Requires numeric id, MID and type 0, checks their relation, never retries writes and only reports success after reading the target state.',
    bodyExample: { song: { id: 101, mid: 'FixtureSongA1', type: 0 }, liked: true },
  },
  albumSubscribe: {
    description:
      'Subscribe or unsubscribe an album by album MID for the signed-in account. Reads the target state, writes at most once and confirms it again; unknown outcomes return 502 and must not be retried blindly.',
    bodyExample: { id: 'FixtureAlbumA1', subscribed: true },
  },
  subscriptionStatus: {
    description:
      'Query verified playlist, album or song subscription protocols, up to 100 identifiers. items report subscribed, not-subscribed or unknown; a failed query returns an error, never false.',
    queryParams: [
      {
        key: 'type',
        label: 'type',
        required: true,
        description: 'playlist, album or song',
        defaultValue: 'playlist',
      },
      {
        key: 'ids',
        label: 'ids',
        required: true,
        description: 'Comma-separated numeric playlist IDs or album/song MIDs',
        defaultValue: '70001,70002',
      },
    ],
  },
  playlistTracks: {
    description:
      'Add or remove confirmed catalog songs in your own ordinary playlist. POST only; the server resolves tid to a directory, rejects system playlists and unknown song types, and never retries writes. type: 0 declares a catalog song, independent of the Android response type. Only changed false adds verification.status after at most one read of the first 100 tracks, without paging or retries: present means all requested songs were found; absent requires a complete read with none found; mixed, incomplete or failed reads are unknown. Verification never changes the original HTTP or changed result. Use /user/song/like for likes.',
    bodyExample: { tid: '70001', op: 'add', songs: [{ id: 101, type: 0 }] },
  },
  userVip: {
    description:
      'Get the membership level of the signed-in account. vipLevel is free, green (green diamond), super (super VIP) or unknown: HugeVip 1 means super, otherwise iVipFlag 1 means green and 0 means free; a missing or unexpected flag stays unknown instead of free. isVip is still true only when iVipFlag equals 1. Neither field decides playback: a free account may still play full songs. Other known flags remain in upstream.',
  },
  qrKey: {
    description: 'Create one short-lived native QQ Music QR login session.',
    queryParams: [
      {
        key: 'channel',
        label: 'Login Channel',
        description:
          'qq (scan with mobile QQ, default), wechat (scan with WeChat) or qqmusic (scan with the QQ Music app, whether its account is linked to QQ or WeChat). On a serverless deployment without a relay, qq uses the QQ web login over plain HTTP and its code expires after about 120 s; qqmusic needs a relay.',
      },
    ],
  },
  loginChannels: {
    description:
      'List login channels, session mode, configuration status and supported backend methods. No login or upstream request is needed. Feature flags describe implementation; check configured and login status separately.',
  },
  qrCreate: {
    description: 'Create the PNG QR image for an existing login session.',
    queryParams: [
      {
        key: 'key',
        label: 'QR Key',
        required: true,
        description: 'Opaque key returned by /login/qr/key.',
      },
    ],
  },
  qrCheck: {
    description:
      'Poll QR state: 800 expired or failed, 801 waiting, 802 scanned, or 803 confirmed. Stored WeChat sessions retain 802 after a later waiting response; only a completed credential exchange returns 803. On Node a WeChat check waits up to 15 s (QQ_WECHAT_POLL_BUDGET_MS) when nothing changes, so do not give this request a shorter client timeout. Sealed serverless checks still reconstruct progress per request. Safe WeChat poll/state/check evidence is available in server logs at info level without adding response fields. A failed 800 may add upstreamErrorKey for a registered code, and mobile QQ may add primaryFailure with fallbackAttempted when its fallback check overwrote the first failure. A recognised failure adds failureHint with a key and a default English message.',
    queryParams: [
      {
        key: 'key',
        label: 'QR Key',
        required: true,
        description: 'Opaque key returned by /login/qr/key.',
      },
    ],
  },
  qrCancel: {
    description: 'Release one QR login session by key. Unknown keys still return 200.',
    queryParams: [
      {
        key: 'key',
        label: 'QR Key',
        required: true,
        description: 'Opaque key returned by /login/qr/key.',
      },
    ],
  },
  loginStatus: {
    description: 'Get the authenticated QQ Music profile for the current session.',
  },
  loginRefresh: {
    description:
      'Renew the current session on request. Answers { token, rotated, expiresAt }. Only within 6 hours of expiry does it call upstream; serverless then hands out a new token (keep it when rotated is true; the old one stays valid until its own expiry), capped at 30 days from the first login. Stored deployments refresh silently and keep the same token. A failed refresh keeps the current token and waits 5 minutes on that instance. 401 without a valid session.',
  },
  logout: {
    description: 'Clear the current in-memory QQ Music login session.',
  },
  userDetail: {
    description:
      'Get the current authenticated QQ Music user detail. A gateway and credential-code conflict answers 502 without clearing the session; credential rejection alone remains 401.',
  },
  getUserPlaylist: {
    description:
      "Get created and collected playlists for the authenticated user. Collected playlists keep their original cover; QQ Music's official playlists use their first song's album cover.",
    queryParams: [
      {
        key: 'uid',
        label: 'User ID',
        description:
          'Defaults to the authenticated QQ Music account. Only that account is supported; another account answers 400.',
      },
      {
        key: 'favoriteOffset',
        label: 'Favourite offset',
        description:
          'Continue reading collected playlists from this position. Use the nextFavoriteOffset of the previous answer; that round returns collected playlists only.',
      },
      {
        key: 'playCount',
        label: 'Play count',
        description:
          'Set to 1 to add play_cnt from the legacy list endpoints (matched by playlist id, non-negative only) and playCountComplete. The counts are cached per account for 10 minutes. Without it the request and answer are unchanged.',
      },
    ],
  },
  getUserAlbums: {
    description: 'Get the albums the authenticated user has added to their favourites.',
    queryParams: [
      { key: 'offset', label: 'Offset', description: 'Zero-based album offset.' },
      { key: 'limit', label: 'Limit', description: 'Page size, up to 100.' },
    ],
  },
  getUserLikedSongs: {
    description: "Get the authenticated user's built-in liked songs.",
    queryParams: [
      { key: 'offset', label: 'Offset', description: 'Zero-based song offset.' },
      { key: 'limit', label: 'Limit', description: 'Page size, up to 100.' },
    ],
  },
  getOwnedPlaylistSongs: {
    description:
      "Get songs of the authenticated user's own playlist, including ones set to private.",
    queryParams: [
      {
        key: 'tid',
        label: 'Playlist ID',
        description:
          'The tid listed by /user/playlist. Always pass it; dirid alone only resolves your own folders.',
      },
      {
        key: 'dirid',
        label: 'Directory ID',
        description: 'The dirId listed by /user/playlist. 201 is the built-in liked songs.',
      },
      { key: 'offset', label: 'Offset', description: 'Zero-based song offset.' },
      { key: 'limit', label: 'Limit', description: 'Page size, up to 100.' },
      {
        key: 'playCount',
        label: 'Play count',
        description:
          'Set to 1 to add play_cnt from the same detail reply, with no extra upstream request. Private playlists show 0; liked songs and unusable values are left out. Without it the answer is unchanged.',
      },
    ],
  },
  userDailySongs: {
    description:
      "Get today's Daily 30 songs for the authenticated user. It reads the account's own daily playlist, so it works whether or not the playlist is in your favorites. Songs keep the upstream format. Without a session it answers 401; when the upstream returns no songs it answers 422. There is no refresh parameter.",
  },
  userCloud: {
    description:
      "List the songs in the authenticated user's QQ Music cloud drive. Each item has song (upstream track format, or null), fileName, addTime (milliseconds, or null) and playable. Playable items match a catalog song and play through /getMusicPlay with song.mid; uploaded files that match nothing are listed but not playable. An empty drive answers 200 with an empty list; without a session it answers 401.",
    queryParams: [
      { key: 'limit', label: 'Limit', description: 'Page size, 200 by default, up to 1000.' },
      { key: 'offset', label: 'Offset', description: 'Zero-based song offset.' },
    ],
  },
  getGuessYouLike: {
    description:
      "Get a few songs from QQ Music's Guess You Like radio for the authenticated user (usually 5 per call). Songs keep the upstream format; reasons, when given, are in extras. Without a session it answers 401; when the upstream returns no songs it answers 422.",
  },
  updateRecommendationPreferences: {
    description:
      'Experimental and off by default (trusted host flag QQ_UNVERIFIED_WRITES_ENABLED). Change music preference scores: reads current values, replaces only the given keys, writes the full list once and reads back. No retry; unknown outcomes are marked writeAttempted. Real-account acceptance is pending.',
  },
  getRecommendationPreferences: {
    description:
      'Read the account music preferences shared by Personal FM and Daily 30: each item key, name and current score (0-100). Read from the first-page data of the official preference page without running its scripts; songs on that page are not returned. Writing preferences is not offered yet.',
  },
  getGuessYouLikeModes: {
    description:
      'Read the single-choice listening-mode catalog of Guess You Like (radio 99): primary modes, scenes, suggestions and the current selection. Read only; no mode switch is offered. Mode ids and pool ids are not radio IDs or preference keys.',
  },
  getRecommendPlaylists: {
    description:
      'Get recommended playlists from the QQ Music playlist square. Uses the login session when there is one, otherwise reads anonymously. more only repeats the upstream hint; there is no continuation offset.',
    queryParams: [
      { key: 'limit', label: 'Limit', description: 'How many playlists, 25 by default, up to 60.' },
    ],
  },
  getPlaylistCategories: {
    description:
      'List the official playlist categories in groups (id and name). Read anonymously; no session needed.',
  },
  getCategoryPlaylists: {
    description:
      'Get official playlists of one category, in the same shape as /recommend/playlists, plus total and more. Read anonymously with caller 0. Public pages start at 1; the upstream page is one less. Uses category content total_cnt for total and more, and returns 422 for an empty page.',
    queryParams: [
      { key: 'id', label: 'Category id', description: 'Category id from /recommend/categories.' },
      { key: 'page', label: 'Page', description: 'Page number starting at 1.' },
      { key: 'limit', label: 'Limit', description: 'Playlists per page, 20 by default, up to 40.' },
    ],
  },
  getNewSongs: {
    description:
      'Get new songs for one area (latest by default) with the list of areas. Songs keep the upstream format. Read anonymously.',
    queryParams: [
      {
        key: 'area',
        label: 'Area',
        description: 'Area id from the areas list; 5 (latest) by default.',
      },
    ],
  },
  getSimilarSongs: {
    description:
      'Get songs similar to one song. Requires login: without a session the upstream only answers an empty list.',
    queryParams: [
      {
        key: 'id',
        label: 'Song ID',
        description: 'Numeric song id (not the mid).',
        required: true,
      },
    ],
  },
  getRelatedPlaylists: {
    description:
      'Get playlists that contain one song. Requires login: without a session the upstream only answers an empty list.',
    queryParams: [
      {
        key: 'id',
        label: 'Song ID',
        description: 'Numeric song id (not the mid).',
        required: true,
      },
    ],
  },
  getPersonalFm: {
    description:
      'Read one personal FM batch with a required session. Uses radar songs, independently of guess-you-like. Does not retry a failed batch; real-account acceptance is pending.',
    queryParams: [
      {
        key: 'page',
        label: 'Page',
        description:
          'Integer from 1 to 100; defaults to 1. Follow nextPage; a local page limit is not an upstream end.',
      },
    ],
  },
  getRadioRecommendationModes: {
    description:
      'Read single-choice radio-ID options for official recommendation radios. First page only; no saved account selection is claimed. Separate from guess-you-like RadioConfig. Real-account acceptance is pending.',
  },
  getRadioRecommendationTracks: {
    description:
      'Read one official recommendation-radio batch by radio ID. No settings write, cursor or retry; real-account acceptance is pending. Existing radio routes are unchanged.',
    queryParams: [
      {
        key: 'id',
        label: 'Radio ID',
        description:
          'Positive safe numeric radio ID; id 99 keeps its separate guess-you-like route.',
        required: true,
      },
    ],
  },
  getBlacklist: {
    description:
      'Read the first song, singer or style blacklist page for this account. Completeness and pagination are unverified; internal tokens are not exposed. API real-account acceptance is pending.',
    queryParams: [
      {
        key: 'type',
        label: 'Type',
        description: 'song, singer or style. Only the first page is supported.',
        required: true,
      },
    ],
  },
  addBlacklist: {
    description:
      'Classified dislike write. A songs-only body is enabled by default (song dislike); singers, styles and mixed selections need the trusted QQ_UNVERIFIED_WRITES_ENABLED=1 flag. Selected targets only; one write, then first-page checks. accepted is acknowledgement; only verified=true confirms presence. No replacement is required.',
    bodyExample: { songs: ['91001'] },
  },
  removeBlacklist: {
    description:
      'Experimental single-entry cancellation. Requires trusted QQ_UNVERIFIED_WRITES_ENABLED=1. Uses fresh metadata from this account first page. First-page absence never claims complete removal; verified remains false until complete traversal is verified.',
    bodyExample: { type: 'song', id: '91001', idType: 1 },
  },
  getBlacklistStyleOptions: {
    description:
      'Read the available style choices of one song. Some songs have no choices. Status values retain their upstream numeric form without inferred meanings.',
    queryParams: [
      {
        key: 'songId',
        label: 'Song ID',
        description: 'Positive numeric song ID, not a mid.',
        required: true,
      },
    ],
  },
  dailyHistoryDates: {
    description:
      'Read only the daily recommendation dates returned for this account. Dates can be sparse; real-account API acceptance is pending.',
  },
  dailyHistorySongs: {
    description:
      'Read the actual songs of one daily recommendation date. Does not create, subscribe to, or edit a playlist. Real-account API acceptance is pending.',
    queryParams: [
      {
        key: 'date',
        label: 'Date',
        description: 'Calendar date as YYYY-MM-DD, from the history dates list.',
        required: true,
      },
    ],
  },
  getRecommendRadar: {
    description:
      'Get one page (about 10 songs) of the radar, the endless personal song stream. Uses the session when present, otherwise reads anonymously.',
    queryParams: [
      { key: 'page', label: 'Page', description: 'Page number; 1 by default, at most 100.' },
    ],
  },
  getNewAlbums: {
    description:
      'Get new albums for one area (mainland by default) with the list of areas, one page at a time. Read anonymously.',
    queryParams: [
      { key: 'area', label: 'Area', description: 'Area id from the areas list; 1 by default.' },
      { key: 'offset', label: 'Offset', description: 'Albums to skip; 0 by default.' },
      { key: 'limit', label: 'Limit', description: 'Albums per page; 20 by default, at most 40.' },
    ],
  },
  getRecommendToplists: {
    description:
      'Get all charts by group with id, title, cover, period and a few preview songs. Read anonymously.',
  },
  getRecommendToplistSongs: {
    description:
      'Get the songs of one chart. Songs keep the upstream format. Without period the latest issue is read. Read anonymously.',
    queryParams: [
      {
        key: 'id',
        label: 'Chart ID',
        description: 'Chart id from /recommend/toplists.',
        required: true,
      },
      {
        key: 'period',
        label: 'Period',
        description: 'Issue from the chart list (YYYY-MM-DD or YYYY_NN); latest when left out.',
      },
      { key: 'offset', label: 'Offset', description: 'Songs to skip; 0 by default.' },
      { key: 'limit', label: 'Limit', description: 'Songs per page; 20 by default, at most 100.' },
    ],
  },
  getRadioList: {
    description:
      'List QQ Music radio stations in groups for the authenticated user. Each radio has id, title, picurl and listenNum when known. Without a session it answers 401.',
  },
  getRadioTracks: {
    description:
      'Get a few songs from one radio station for the authenticated user. Radio 99 is Guess You Like and may add extras with reasons. Songs keep the upstream format. Without a session it answers 401; a bad id answers 400.',
    queryParams: [{ key: 'id', label: 'Radio id', description: 'Radio id from /radio/list.' }],
  },
  getHotSearches: {
    description:
      'Get the hot search keywords, each with an optional title and description. Read anonymously.',
  },
  getSearchSuggestions: {
    description:
      'Get search word suggestions for a keyword (only search words, no other items). Read anonymously.',
    queryParams: [
      {
        key: 'keyword',
        label: 'Keyword',
        description: 'What has been typed so far, up to 60 characters.',
      },
    ],
  },
  listSingers: {
    description:
      'List singers with optional filters, plus the filter values to choose from. The upstream gives 80 singers per page. Read anonymously.',
    queryParams: [
      { key: 'area', label: 'Area', description: 'Area id from tags.area; -100 (all) by default.' },
      { key: 'sex', label: 'Sex', description: 'Id from tags.sex; -100 (all) by default.' },
      { key: 'genre', label: 'Genre', description: 'Id from tags.genre; -100 (all) by default.' },
      {
        key: 'index',
        label: 'Index',
        description: 'Initial letter id from tags.index; -100 (all) by default.',
      },
      { key: 'offset', label: 'Offset', description: 'Singers to skip; 0 by default.' },
      { key: 'limit', label: 'Limit', description: 'Singers per page; 80 by default, at most 80.' },
    ],
  },
  getSingerDetail: {
    description: 'Get one singer with picture, description and wiki text. Read anonymously.',
    queryParams: [{ key: 'mid', label: 'Singer MID', description: 'Singer MID.' }],
  },
  getSingerHomepage: {
    description: 'Get the fan and follow counts of one singer. Read anonymously.',
    queryParams: [{ key: 'mid', label: 'Singer MID', description: 'Singer MID.' }],
  },
  getSimilarSingers: {
    description: 'Get up to 10 similar singers. Some singers have none (422). Read anonymously.',
    queryParams: [{ key: 'mid', label: 'Singer MID', description: 'Singer MID.' }],
  },
  getSingerSongs: {
    description:
      'Get songs of one singer in the upstream format, one page at a time. Read anonymously.',
    queryParams: [
      { key: 'mid', label: 'Singer MID', description: 'Singer MID.' },
      { key: 'offset', label: 'Offset', description: 'Songs to skip; 0 by default.' },
      { key: 'limit', label: 'Limit', description: 'Songs per page; 30 by default, at most 30.' },
    ],
  },
  getSingerMvs: {
    description: 'Get MVs of one singer, one page at a time. Read anonymously.',
    queryParams: [
      { key: 'mid', label: 'Singer MID', description: 'Singer MID.' },
      { key: 'offset', label: 'Offset', description: 'MVs to skip; 0 by default.' },
      { key: 'limit', label: 'Limit', description: 'MVs per page; 20 by default, at most 40.' },
    ],
  },
  getHotComments: {
    description:
      'Get hot comments of one song, one page at a time. Pages after the first are not fully verified. Read anonymously.',
    queryParams: [
      { key: 'id', label: 'Song id', description: 'Numeric song id.' },
      { key: 'offset', label: 'Offset', description: 'Comments to skip; 0 by default.' },
      {
        key: 'limit',
        label: 'Limit',
        description: 'Comments per page; 20 by default, at most 50.',
      },
    ],
  },
  getNewComments: {
    description:
      'Get the newest comments of one song, one page at a time. Pages after the first are not fully verified. Read anonymously.',
    queryParams: [
      { key: 'id', label: 'Song id', description: 'Numeric song id.' },
      { key: 'offset', label: 'Offset', description: 'Comments to skip; 0 by default.' },
      {
        key: 'limit',
        label: 'Limit',
        description: 'Comments per page; 20 by default, at most 50.',
      },
    ],
  },
  getSongLabels: {
    description: 'Get the labels of one song (text with optional icon and link). Read anonymously.',
    queryParams: [{ key: 'id', label: 'Song id', description: 'Numeric song id.' }],
  },
  getMvList: {
    description:
      'List MVs with optional area and version filters, plus the filter values to choose from. Read anonymously.',
    queryParams: [
      { key: 'area', label: 'Area', description: 'Area id from tags.area; 15 (all) by default.' },
      {
        key: 'version',
        label: 'Version',
        description: 'Version id from tags.version; 7 (all) by default.',
      },
      { key: 'offset', label: 'Offset', description: 'MVs to skip; 0 by default.' },
      { key: 'limit', label: 'Limit', description: 'MVs per page; 20 by default, at most 40.' },
    ],
  },
  getMvDetail: {
    description: 'Get one MV with title, description, cover, counts and singers. Read anonymously.',
    queryParams: [{ key: 'vid', label: 'MV vid', description: 'MV vid.' }],
  },
  getMvUrl: {
    description:
      'Get the MP4 files of one MV that come with links, lowest quality first. Works without logging in and uses the session when there is one; logging in may give more qualities. Files without links are left out.',
    queryParams: [{ key: 'vid', label: 'MV vid', description: 'MV vid.' }],
  },
  getSongMvs: {
    description: 'Get the MVs related to one song. Read anonymously.',
    queryParams: [{ key: 'id', label: 'Song id', description: 'Numeric song id.' }],
  },
  getCommentCount: {
    description: 'Get how many comments one song has. Read anonymously.',
    queryParams: [{ key: 'id', label: 'Song id', description: 'Numeric song id.' }],
  },
  getSearch: {
    description:
      'Search songs, albums, playlists or singers by keyword. Works without logging in and uses the session when there is one. When the upstream still rejects a search it answers 502 search.rejected (code 2001); logging in usually avoids that. Items keep the upstream format with all MIDs. No results is 200 with an empty list; a rejection is never reported as empty. Not retried automatically.',
    queryParams: [
      { key: 'keyword', label: 'Keyword', description: 'Search words, up to 60 characters.' },
      {
        key: 'type',
        label: 'Type',
        description: 'song (default), album, playlist or singer.',
      },
      { key: 'page', label: 'Page', description: 'Page number starting at 1.' },
      { key: 'limit', label: 'Limit', description: 'Items per page, 10 by default, up to 20.' },
    ],
  },
  getSongInfo: {
    description: 'Get song detail by song MID and optional song ID.',
  },
  getSongListDetail: {
    description:
      'Get song list detail by disstid. With a login session, also reads the QQ Music algorithmic playlists the anonymous CGI rejects with code 10.',
  },
  getSingerAlbum: {
    description: 'Get album list for a singer.',
  },
  getLyric: {
    id: 'get-lyric',
    description:
      'Get song lyrics as LRC text on Node and serverless, no login needed. isFormat=true also splits it into timed lines. trans is passed through as upstream returns it and is often empty; trans=1 asks a second lyric endpoint once when it is empty.',
    queryParams: [
      {
        key: 'songmid',
        label: 'Song MID',
        required: true,
        placeholder: '003rJSwm3TechU',
        description: 'Song MID used by QQ Music.',
        defaultValue: '003rJSwm3TechU',
      },
      {
        key: 'isFormat',
        label: 'Format Lyric',
        inputType: 'boolean',
        placeholder: 'false',
        description: 'true/1 to format LRC text.',
        defaultValue: false,
      },
      {
        key: 'trans',
        label: 'Translation',
        description:
          'Set to 1 to fill an empty trans from a second lyric endpoint (one extra request, tried once, base64 LRC like the original). Without it the request and answer are unchanged.',
      },
    ],
  },
  getMusicPlay: {
    description:
      'Get playable music URL by song MID; an opaque QR session enables authenticated playback. A missing URL adds restriction (still url_unavailable) and a plain English hint. Authenticated m4a/128 failures may query up to 10 song details: only complete matching features suggest region or membership; unknown features stay unconfirmed. QQ_PLAYBACK_HINTS_ENABLED=0 disables these hints and lookups. WeChat matching features are supported but not yet verified with controlled live tests. ape checks size_ape first (up to 10 songs); no file and failed checks have different hints and optional restriction.failureReason, and neither asks for a URL. preview=1 takes priority, asking for a preview only when size_try is above 0 and a media id is known, marking successful entries preview: true. With a session, a readable detail whose size_try is exactly 0 gets playback.preview-missing (no preview file); other skipped previews get playback.preview-unavailable. quality=best tries flac, then 320, then 128, skipping levels whose size_flac/size_320mp3 is not above 0 (up to 10 detail lookups), and adds quality to each entry with the level actually used; without a readable detail, past the lookup limit, or without a session it asks for 128 directly. With a session, it retries once, in one batched request, the m4a/128 songs (including the last best level) whose final hint is playback.reason-unconfirmed; if the retry still fails or errors, the first result is returned.',
  },
  getAlbumInfo: {
    id: 'get-album-info',
    description: 'Get album detail by album MID.',
    queryParams: [
      {
        key: 'albummid',
        label: 'Album MID',
        required: true,
        placeholder: '0016l2F430zMux',
        description: 'Album MID.',
        defaultValue: '0016l2F430zMux',
      },
    ],
  },
};

export const createApiExplorerEndpoint = (
  route: ApiExplorerBaseRoute,
  override: Partial<ApiExplorerEndpoint> = {},
): ApiExplorerEndpoint => {
  const generatedQueryParams = extractRouteParams(route.routePath);

  return {
    id: createApiExplorerId(route.name),
    name: route.name,
    category: route.category,
    description: `Call ${route.name} endpoint.`,
    method: route.method,
    routePath: route.routePath,
    path: stripRouteParams(route.routePath),
    queryParams: generatedQueryParams.length ? generatedQueryParams : undefined,
    ...override,
  };
};

export const apiExplorerEndpoints: ApiExplorerEndpoint[] = apiExplorerBaseRoutes.map((route) =>
  createApiExplorerEndpoint(route, apiExplorerOverrides[route.name]),
);

export const apiExplorerMetadata: ApiExplorerMetadata = {
  title: 'QQ Music API Explorer',
  description:
    'A lightweight local API explorer for quick request testing, parameter input, and response preview.',
  endpoints: apiExplorerEndpoints,
};
