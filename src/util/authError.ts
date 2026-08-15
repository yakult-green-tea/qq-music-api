/**
 * 上游明确拒绝了我们送出的凭证时抛出的错误，与「上游因为别的原因失败」区分开。
 *
 * 控制器层把它映射成 401，客户端据此清掉已经失效的会话；其余上游失败继续回 500，因为对那些情况
 * 重试才是正确反应，把它们也当成登出会在一次网络抖动后就把用户踢出去。
 *
 * 放在 `util/` 且不引入任何模块是刻意的：控制器错误中间件需要认得这个类型，而如果它反过来 import
 * `services/auth/qrLogin`，就会把整个鉴权栈连同 `ws` 一起拖进日志路径的依赖闭包里。
 */
export class AuthCredentialRejectedError extends Error {
  /** 控制器与中间件读这个值决定回应状态码。 */
  public readonly httpStatus = 401;

  constructor(public readonly upstreamCode?: number) {
    super('Login required');
    this.name = 'AuthCredentialRejectedError';
  }
}
