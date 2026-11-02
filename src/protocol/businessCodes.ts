import type { EvidenceLevel } from './evidence';

// src/protocol/businessCodes.ts
//
// 上游数字码的登记表：哪一步调用、哪一层、哪个数字、什么意思、凭什么这样说。
//
// 同一个数字在不同调用、不同层可以完全不同义（例如 104400 在带凭证的读取里表示凭证失效，
// 在歌手接口的内层却只是参数不对），所以查表一定要同时给出调用和层级，只给数字查不到任何东西。
// 没有「对所有调用都成立」的条目；没登记的组合一律当成未知，不推断。零依赖，两个运行时共用。

/** 哪一步上游调用。扫码登录按通道分开：两个通道的同名步骤背后不是同一次请求。 */
export const UPSTREAM_OPERATIONS = [
  /** 手机 QQ 扫码：用扫码得到的票据换正式凭证。 */
  'login.qq.credential-exchange',
  /** 手机 QQ 扫码：换凭证失败后，直接拿扫码票据去读登录用户。 */
  'login.qq.fallback-validation',
  /** 手机 QQ 扫码走网页登录（Serverless）：用 QQ 互联给的 code 换凭证（`QQConnectLogin.LoginServer.QQLogin`）。 */
  'login.qq.ptlogin-exchange',
  /** 微信扫码：用授权码换正式凭证。 */
  'login.wechat.credential-exchange',
  /** 微信扫码：用刚换到的凭证读登录用户。 */
  'login.wechat.credential-validation',
  /** 微信扫码：验证被拒后刷新一次凭证。 */
  'login.wechat.credential-refresh',
  /** 登录之后带凭证的 musicu 读取（资料、歌单、喜欢、取播放链接等）。 */
  'session.authenticated-read',
  /** 会员状态；未验证的非零码不按其他读取推断为凭证失效。 */
  'user.vip',
  /** 写入前的自建清单核对；不借用其他操作的非零码语义。 */
  'playlist.owned-list',
  /** 无变更后的单次内容核对；失败只让可选说明为 unknown，不改变原写入结果。 */
  'playlist.track-verification',
  /** 已验证调用形状，非零码的含义尚未确认，保持未知。 */
  'playlist.subscribe',
  'playlist.unsubscribe',
  'song.like',
  'song.unlike',
  'song.identity-check',
  'album.subscribe',
  'album.unsubscribe',
  /** 建立／删除按各自操作保留未知非零码，不扩大凭证失效语义。 */
  'playlist.create',
  'playlist.delete',
  'playlist.edit-read',
  'playlist.rename',
  'subscription.playlist-status',
  'subscription.album-status',
  'subscription.song-status',
  /** 猜你喜欢（`get_radio_track` id 99）。 */
  'recommend.guess-you-like',
  /** 每日 30 首（带凭证按系统目录 202 读 `uniform_get_Dissinfo`），要登录。 */
  'recommend.daily-songs',
  'recommend.daily-history',
  'recommend.blacklist-read',
  'recommend.official-radio',
  /** 音乐云盘（`GetMatchAudio`），要登录；非零码除了凭证失效都还是未知。 */
  'cloud.list',
  /** 歌单广场的推荐（`GetRecommendFeed`），有会话就带凭证。 */
  'recommend.playlists',
  /** 歌单分类（`get_hot_category`），匿名。 */
  'recommend.categories',
  /** 分类歌单（`get_playlist_by_category`），匿名。 */
  'recommend.category-playlists',
  /** 新歌速递（`get_new_song_info`），匿名。 */
  'recommend.new-songs',
  /** 相似歌曲（`TrackRelationServer.GetSimilarSongs`），要登录。 */
  'song.similar',
  /** 包含这首歌的歌单（`TrackRelationServer.GetRelatedPlaylist`），要登录。 */
  'song.related-playlists',
  /** 刷歌模式（`TrackRelationServer.GetRadarSong`），有会话就带凭证。 */
  'recommend.radar',
  /** 新碟地区清单（`get_new_album_area`），匿名。 */
  'recommend.new-album-areas',
  /** 新碟上架（`get_new_album_info`），匿名。 */
  'recommend.new-albums',
  /** 排行榜清单（`ToplistInfoServer.GetAll`），匿名。 */
  'recommend.toplists',
  /** 单榜歌曲（`ToplistInfoServer.GetDetail`），匿名。 */
  'recommend.toplist',
  /** 关键字搜索（桌面版 `DoSearchForQQMusicDesktop`），歌曲要登录、其他类型匿名可读；非零码都还是未知。 */
  'search',
  /** 热搜（`HotkeyService.GetHotkeyForQQMusicMobile`），匿名；非零码都还是未知。 */
  'search.hot',
  /** 搜索建议（`SmartBoxCgi.GetSmartBoxResult`），匿名；非零码都还是未知。 */
  'search.suggest',
  /** 搜索直接命中（旧 CGI `smartbox_new.fcg`），匿名；非零码都还是未知。 */
  'search.match',
  /** 完整歌单分类（旧 CGI `fcg_get_diss_tag_conf.fcg`），匿名；非零码都还是未知。 */
  'recommend.categories-all',
  /** 按排序读分类歌单（旧 CGI `fcg_get_diss_by_tag.fcg`），匿名；非零码都还是未知。 */
  'recommend.category-playlists-sorted',
  /** 一次读多首歌的详情（`pf_song_detail_svr.get_song_detail_yqq`），匿名；非零码都还是未知。 */
  'song.batch',
  /** 匿名的电台分类（`pf.radiosvr/GetRadiolist`）；非零码都还是未知。 */
  'radio.categories',
  /** 歌曲以外的资源也能读的评论（旧 CGI `fcg_global_comment_h5.fcg`），匿名；非零码都还是未知。 */
  'comment.list',
  /** 歌手清单（`SingerList.GetSingerListIndex`），匿名；非零码都还是未知。 */
  'singer.list',
  /** 歌手资料（`SingerInfoInter.GetSingerDetail`），匿名。 */
  'singer.detail',
  /** 歌手主页（`UnifiedHomepageSrv.GetHomepageHeader`），匿名；成功时单项码是 10000，由请求放行。 */
  'singer.homepage',
  /** 相似歌手（`SimilarSingerSvr.GetSimilarSingerList`），匿名。 */
  'singer.similar',
  /** 歌手的歌（`song_list_server.GetSingerSongList`），匿名。 */
  'singer.songs',
  /** 歌手的 MV（`MvInfoProServer.GetSingerMvList`），匿名。 */
  'singer.mvs',
  /** 歌曲热评（`CommentRead.GetHotCommentList`），匿名；非零码都还是未知。 */
  'comment.hot',
  /** 歌曲新评（`CommentRead.GetNewCommentList`），匿名。 */
  'comment.new',
  /** 歌曲评论数（`CommentCountSrv.GetCmCount`），匿名；成功时单项码是 10000，由请求放行。 */
  'comment.count',
  /** MV 筛选值（`MvInfoProServer.GetAllocTag`），匿名；读不到不影响清单。 */
  'mv.tags',
  /** MV 清单（`MvInfoProServer.GetAllocMvInfo`），匿名；非零码都还是未知。 */
  'mv.list',
  /** MV 详情（`VideoDataServer.get_video_info_batch`），匿名。 */
  'mv.detail',
  /** MV 播放链接（`MvUrlProxy.GetMvUrls`），匿名；单档的码另外看，不在这里登记。 */
  'mv.url',
  /** 歌曲相关 MV（`MvInfoProServer.GetSongRelatedMv`），匿名。 */
  'song.mvs',
  /** 歌曲标签（`TrackRelationServer.GetSongLabels`），匿名；非零码都还是未知。 */
  'song.labels',
  /** 歌词翻译补强（`GetPlayLyricInfo`，crypt 0），匿名；非零码都还是未知，失败只是不补。 */
  'lyric.translation',
  /** 电台清单（`pf.radiosvr/GetRadiolist`），要登录。 */
  'recommend.radio-list',
  /** 99 以外的电台取歌（`pf.radiosvr/GetRadiosonglist`），要登录。 */
  'recommend.radio-tracks',
  /** 网页版每日推荐候选接口（目前没有路由用它，只记录观测）。 */
  'recommend.web-daily-candidate',
  /** 匿名的歌单详情 CGI。 */
  'playlist.anonymous-detail',
  /** 带凭证重读歌单详情。 */
  'playlist.authenticated-detail',
  /** 往歌单里加歌（还没有路由）。 */
  'playlist.add-songs',
  /** 从歌单里删歌（还没有路由）。 */
  'playlist.del-songs',
  /** 收藏的专辑列表（musicu 版，已改走旧 CGI）。 */
  'library.favorite-albums',
  /** 带会话取播放链接（`UrlGetVkey`）。 */
  'playback.authenticated-url',
] as const;

export type UpstreamOperation = (typeof UPSTREAM_OPERATIONS)[number];

/** 码出现在哪一层。不同层的数字不能混用。 */
export type UpstreamCodeLayer =
  /** musicu 顶层 `code`。 */
  | 'gateway'
  /** musicu 单项 `req_N.code`，或旧 CGI 回应里的 `code`。 */
  | 'business'
  /** 单项里的 `subcode`。 */
  | 'business-subcode'
  /** 取链接响应里单曲条目的数字（`midurlinfo[i]`）。 */
  | 'song-entry';

export type BusinessErrorKind =
  | 'credential-invalid'
  | 'rate-limited'
  | 'device-limit'
  | 'account-restricted'
  | 'account-banned'
  | 'account-binding'
  | 'login-rejected'
  | 'not-found'
  | 'upstream-business'
  | 'upstream-gateway';

export interface UpstreamCodeEntry {
  readonly operation: UpstreamOperation;
  readonly sourceLayer: UpstreamCodeLayer;
  readonly upstreamCode: number;
  readonly kind: BusinessErrorKind;
  readonly errorKey: string;
  readonly evidence: EvidenceLevel;
  /** 出处的简述。不写账号、歌名或 id，也不写第三方项目名。 */
  readonly note: string;
  /** 写入请求的「已经是这个状态」候选：协议验证后由请求描述符明确放行，才能当成成功。 */
  readonly disposition?: 'idempotent-candidate';
  /** 给使用者的处理建议。只有出处明确时才写。 */
  readonly suggestedAction?: 'manage-login-devices' | 'wait' | 'sign-in-again';
  /** 是否表示现有会话的凭证已经失效（对应路由上的 401）。只有凭证失效那几条才是 true。 */
  readonly invalidatesSession?: boolean;
}

type EntryBody = Omit<UpstreamCodeEntry, 'operation' | 'sourceLayer' | 'upstreamCode'>;

const entries = (
  operations: readonly UpstreamOperation[],
  sourceLayer: UpstreamCodeLayer,
  codes: readonly number[],
  body: EntryBody,
): UpstreamCodeEntry[] =>
  operations.flatMap((operation) =>
    codes.map((upstreamCode) => ({ operation, sourceLayer, upstreamCode, ...body })),
  );

/**
 * 两个通道换凭证用的是同一个上游方法，刷新凭证也是；登录码只在这几步有意思。
 * 网页登录的换凭证是另一支方法，码义沿用这一组公开资料，那一支没有实测过。
 */
const LOGIN_EXCHANGE: readonly UpstreamOperation[] = [
  'login.qq.credential-exchange',
  'login.qq.ptlogin-exchange',
  'login.wechat.credential-exchange',
  'login.wechat.credential-refresh',
];

/** 带凭证读取时，上游用这几个码表示凭证不被认可。 */
const CREDENTIAL_CODES = [1000, 104400, 104401] as const;

const credentialRejected = (
  operations: readonly UpstreamOperation[],
  note: string,
): UpstreamCodeEntry[] =>
  entries(operations, 'business', CREDENTIAL_CODES, {
    kind: 'credential-invalid',
    errorKey: 'auth.credential-invalid',
    evidence: 'existing-behavior',
    note,
    suggestedAction: 'sign-in-again',
    invalidatesSession: true,
  });

const observedUnknown = (note: string): EntryBody => ({
  kind: 'upstream-business',
  errorKey: 'upstream.unknown',
  evidence: 'observed-response',
  note,
});

export const UPSTREAM_CODES: readonly UpstreamCodeEntry[] = [
  ...entries(LOGIN_EXCHANGE, 'business', [20279], {
    kind: 'device-limit',
    errorKey: 'auth.device-limit',
    evidence: 'protocol-reference',
    note: '公开协议资料：登录设备数已达上限。社区回报里多次出现在手机 QQ 扫码的换凭证步骤；本项目未做受控复现',
    suggestedAction: 'manage-login-devices',
    invalidatesSession: false,
  }),
  ...entries(LOGIN_EXCHANGE, 'business', [20277, 20278], {
    kind: 'account-restricted',
    errorKey: 'auth.account-restricted',
    evidence: 'protocol-reference',
    note: '公开协议资料：账号受限；本项目未实测',
    invalidatesSession: false,
  }),
  ...entries(LOGIN_EXCHANGE, 'business', [20450], {
    kind: 'account-banned',
    errorKey: 'auth.account-banned',
    evidence: 'protocol-reference',
    note: '公开协议资料：账号被封禁；本项目未实测',
    invalidatesSession: false,
  }),
  ...entries(LOGIN_EXCHANGE, 'business', [20272, 20274], {
    kind: 'account-binding',
    errorKey: 'auth.account-binding',
    evidence: 'protocol-reference',
    note: '公开协议资料：账号绑定异常（20272）或缺失（20274）；本项目未实测',
    invalidatesSession: false,
  }),
  ...entries(LOGIN_EXCHANGE, 'business', [20261], {
    kind: 'login-rejected',
    errorKey: 'auth.login-rejected',
    evidence: 'protocol-reference',
    note: '公开协议资料：登录参数不被接受；本项目未实测，只说「被拒」不说原因',
    invalidatesSession: false,
  }),
  ...entries(LOGIN_EXCHANGE, 'business', [104604], {
    kind: 'rate-limited',
    errorKey: 'auth.rate-limited',
    evidence: 'protocol-reference',
    note: '公开协议资料：登录操作过于频繁；本项目未实测。扫码冷却遇到它是 30 秒（其他失败 15 秒）',
    suggestedAction: 'wait',
    invalidatesSession: false,
  }),
  ...entries(
    ['login.qq.credential-exchange'],
    'business',
    [50006],
    observedUnknown('本项目实测见过（手机 QQ 扫码换凭证被拒），原因未知；不能当成设备超限'),
  ),
  ...entries(
    ['login.qq.fallback-validation'],
    'business',
    [1000],
    observedUnknown(
      '本项目实测见过：换凭证失败后改用扫码票据读登录用户也被拒。它盖住了换凭证那一步的真实原因，不能当成会话失效或设备超限',
    ),
  ),
  ...credentialRejected(
    ['session.authenticated-read'],
    '本项目一直以来的处理：带凭证的 musicu 读取在单项这一层回这几个码，表示凭证不被认可，路由回 401',
  ),
  ...credentialRejected(
    [
      'recommend.guess-you-like',
      'recommend.playlists',
      'recommend.radar',
      'song.similar',
      'song.related-playlists',
    ],
    '推荐路由一上线就这样处理：会话解得开但上游不认凭证时回 401，让前端清掉坏会话；猜你喜欢不带凭证时实测回 1000',
  ),
  ...credentialRejected(
    ['recommend.daily-songs'],
    '每日 30 首要登录，照电台路由处理：会话解得开但上游不认凭证时回 401。这个接口没有单独实测过这几个码',
  ),
  ...credentialRejected(
    ['cloud.list'],
    '云盘要登录，沿用其他带凭证读取的处理：会话解得开但上游不认凭证时回 401。这个接口没有单独实测过这几个码',
  ),
  ...credentialRejected(
    ['recommend.radio-list', 'recommend.radio-tracks'],
    '电台路由要登录，沿用其他带凭证读取的处理：会话解得开但上游不认凭证时回 401。这两个接口没有单独实测过这几个码',
  ),
  ...entries(['search'], 'business', [2001], {
    ...observedUnknown(
      '本项目实测见过：精简版搜索匿名搜歌曲时常回 2001（带会话的同一关键字有结果），原因没有分离。不能当成搜不到，也不自动重试',
    ),
    errorKey: 'search.rejected',
  }),
  ...entries(['recommend.guess-you-like'], 'business', [22006], {
    ...observedUnknown('本项目实测见过（带 song_ids 且 num 改成 10 时被拒），原因没有分离'),
    errorKey: 'recommendation.rejected',
  }),
  ...entries(
    ['recommend.web-daily-candidate'],
    'business',
    [500003],
    observedUnknown(
      '本项目实测见过（HTTP 200、网关码 0、单项码 500003），原因未知；不能推断成出口 IP 被拒',
    ),
  ),
  ...entries(
    ['recommend.web-daily-candidate'],
    'business-subcode',
    [860100005],
    observedUnknown('本项目实测见过（与单项码 500003 一起出现），原因未知'),
  ),
  ...entries(['playlist.anonymous-detail'], 'business', [10], {
    ...observedUnknown('本项目实测：算法歌单用匿名接口读不到，要带凭证重读'),
    errorKey: 'playlist.anonymous-unreadable',
  }),
  ...entries(['playlist.authenticated-detail'], 'business', [10004], {
    kind: 'not-found',
    errorKey: 'playlist.not-found',
    evidence: 'observed-response',
    note: '本项目实测：带凭证读一个不存在的歌单',
  }),
  ...entries(['playlist.authenticated-detail'], 'business', [80120], {
    ...observedUnknown('本项目实测见过（不带登录时），还没确认是不是凭证失效，所以不回 401'),
    errorKey: 'playlist.authentication-unverified',
  }),
  ...entries(['playlist.add-songs', 'playlist.del-songs'], 'business', [80092], {
    kind: 'upstream-business',
    errorKey: 'playlist.already-applied',
    evidence: 'protocol-reference',
    note: '公开协议资料：歌曲已经在（或不在）歌单里；写入路由验证协议后才能放行成成功',
    disposition: 'idempotent-candidate',
  }),
  ...entries(['playlist.add-songs'], 'business', [80105], {
    kind: 'upstream-business',
    errorKey: 'playlist.write-rejected',
    evidence: 'third-party-report',
    note: '第三方回报：往「我喜欢」加歌被拒；参数还是权限问题未知',
  }),
  ...entries(
    ['playlist.del-songs'],
    'business',
    [2001],
    observedUnknown(
      '网页实测见过：删歌单里的歌时单项码 2001、data.retCode 0。不能当成成功，也不能当成限流、自动重试或给冷却时间',
    ),
  ),
  ...entries(['library.favorite-albums'], 'business', [80000, 40000], {
    ...observedUnknown('本项目实测：收藏专辑的 musicu 接口不可用，已改走旧 CGI'),
    errorKey: 'album.endpoint-unavailable',
  }),
  ...entries(
    ['playback.authenticated-url'],
    'song-entry',
    [104003],
    observedUnknown(
      '本项目实测见过（免费账号，320 与 128 都有，subcode 1；有的歌 320 被拒、128 拿得到链接）。只表示这一个音质这一次没给链接，原因未分类',
    ),
  ),
];

/** 查表：调用、层级、数字都对得上才有结果；拿到的是副本，改了也不影响登记表。 */
export const lookupUpstreamCode = (
  operation: UpstreamOperation,
  sourceLayer: UpstreamCodeLayer,
  upstreamCode: number,
): UpstreamCodeEntry | undefined => {
  if (!Number.isSafeInteger(upstreamCode) || upstreamCode === 0) return undefined;
  const entry = UPSTREAM_CODES.find(
    (candidate) =>
      candidate.operation === operation &&
      candidate.sourceLayer === sourceLayer &&
      candidate.upstreamCode === upstreamCode,
  );
  return entry ? { ...entry } : undefined;
};

/** 错误核心用来校验调用方给的 errorKey：只有登记表里同一类的 key 才收。 */
export const isRegisteredErrorKey = (value: unknown, kind: string): value is string =>
  typeof value === 'string' &&
  UPSTREAM_CODES.some((entry) => entry.errorKey === value && entry.kind === kind);
