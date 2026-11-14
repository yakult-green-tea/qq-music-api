// src/transport/httpClientTypes.ts
//
// 登录服务与旧路由共用的 HTTP 客户端接口，只有类型。Node 用 axios 实现，serverless 用 fetch 实现；
// 这里只写两边都会用到的那几项，不依赖 axios，serverless 打包时整个文件会被擦掉。

/** 调用方能指定的请求选项。字段名和以前的 axios 选项相同，两种实现都按原来的方式读。 */
export interface HttpRequestConfig {
  url?: string;
  method?: string;
  headers?: Record<string, unknown>;
  /** 拼进网址的查询参数；值是 undefined 或 null 的不送。 */
  params?: Record<string, unknown>;
  data?: unknown;
  /** 不给就当 JSON 读；解析不了时交出原文。 */
  responseType?: 'json' | 'text' | 'arraybuffer';
  signal?: AbortSignal;
  /** 不跟随转址，用于整次请求有明确调用上限的操作。 */
  followRedirects?: false;
  /** 只有 Node 的 axios 实现会读；fetch 实现用自己的时限。 */
  timeout?: number;
  /** 只有 Node 的 axios 实现会用（探测播放 CDN 时限制读多少字节）；fetch 实现不读。 */
  maxContentLength?: number;
}

export interface HttpClientResponse<T = unknown> {
  data: T;
  status: number;
  statusText: string;
  /** 键是小写的标头名；`set-cookie` 是数组。 */
  headers: Record<string, unknown>;
}

/** 登录、续期、带凭证读取用的客户端：每个实例有自己的 Cookie jar，转址自己跟。 */
export interface AuthHttpClient {
  getCookieHeader(): string;
  request<T>(config: HttpRequestConfig): Promise<HttpClientResponse<T>>;
  post<T>(url: string, data?: unknown, config?: HttpRequestConfig): Promise<HttpClientResponse<T>>;
}

/** `y` 和 `c` 会补上各自的基础网址；`u` 本身就是完整的 musicu 网址。 */
export type LegacyRequestTarget = 'y' | 'c' | 'u';

export interface LegacyRequestDefaults {
  readonly baseURL: Readonly<Record<LegacyRequestTarget, string>>;
  readonly referer: Readonly<Record<LegacyRequestTarget, string>>;
  readonly commonParams: Readonly<Record<string, unknown>>;
}

/** 旧路由的请求通道，同时带着各个运行环境自己能给的请求默认值。 */
export interface LegacyHttpTransport {
  /** 只用来诊断，不拿来分支。 */
  readonly kind: string;
  readonly defaults: LegacyRequestDefaults;
  request<T = unknown>(
    url: string,
    method: string,
    options?: HttpRequestConfig,
    target?: string,
  ): Promise<HttpClientResponse<T>>;
}
