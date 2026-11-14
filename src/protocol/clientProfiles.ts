// src/protocol/clientProfiles.ts
//
// 送给上游的客户端身份集中放在这里：安卓客户端（带会话的请求和登录）、匿名网页、精简版客户端。
// 三种身份各有各的用途，上游按它们回不同的内容，所以分开放，不为了省事改成同一组 ct／cv：
//   - 安卓客户端：登录、带会话的读写和取播放链接都靠它，设备信息和账号凭证另外带上。
//   - 匿名网页：不带账号就能读的曲库、推荐、MV 等，只有 ct 和 cv。
//   - 精简版客户端：不登录搜歌只有它搜得到，补歌词翻译也借用它。
// 这里只有常数和拼字符串的小函数，零依赖，两个运行时共用。

/**
 * 安卓客户端的固定部分。`version` 同时是 comm 的 cv、v 和 User-Agent 里的版本号，
 * `versionName` 是申请设备指纹时送的同一个版本，三处要对得上，改的时候一起改。
 */
export const ANDROID_CLIENT = {
  /** 客户端类型。 */
  ct: 11,
  version: 14090008,
  versionName: '14.9.0.8',
  /** 渠道号，comm 和申请设备指纹用同一个。 */
  channelId: '10003505',
  appId: 'qqmusic',
} as const;

export const androidUserAgent = (osRelease: string): string =>
  `QQMusic ${ANDROID_CLIENT.version}(android ${osRelease})`;

/** 生成登录二维码那一次请求，comm 里的客户端类型和版本要换成这一组。 */
export const ANDROID_QR_CREATE_COMM = { ct: 23, cv: 0 } as const;

/** 匿名网页身份。 */
export const WEB_ANONYMOUS_COMM = { ct: 24, cv: 0 } as const;

/** 有几条匿名读取是带着数字 0 的 uin 验证的，照原样保留。 */
export const WEB_ANONYMOUS_COMM_WITH_UIN = { ct: 24, cv: 0, uin: 0 } as const;

/**
 * 精简版客户端的匿名身份：只放协议需要的应用与版本常数，不带任何设备指纹。
 * 标头里的 `tmeLoginType=-1` 表示未登录。
 */
export const LITE_ANONYMOUS_COMM = {
  ct: 11,
  cv: '1003006',
  v: '1003006',
  tmeAppID: 'qqmusiclight',
  nettype: 'NETWORK_WIFI',
  udid: '0',
  uid: '0',
};

/** 三种身份实际送的 ct／cv，音源描述记「这次用的是哪一组」时查这里，不另写一份。 */
export const CLIENT_COMM_OF = {
  android: { ct: ANDROID_CLIENT.ct, cv: ANDROID_CLIENT.version },
  web: { ct: WEB_ANONYMOUS_COMM.ct, cv: WEB_ANONYMOUS_COMM.cv },
  lite: { ct: LITE_ANONYMOUS_COMM.ct, cv: LITE_ANONYMOUS_COMM.cv },
} as const;

export type ClientProfileId = keyof typeof CLIENT_COMM_OF;

export const LITE_ANONYMOUS_HEADERS = {
  Cookie: 'tmeLoginType=-1',
  'User-Agent': 'okhttp/3.14.9',
};
