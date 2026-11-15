# 错误对照表

拿到一个错误，先在这里查：它是什么意思、QQ 实际回了什么、能不能跟使用者说原因、前端该怎么处理。接口本身怎么用请看[使用文档](./README.md)。

## 先看哪一层

按顺序看，停在第一个能下结论的地方：

1. **HTTP 状态码**：决定要不要清掉登录、能不能重试。
2. **`kind`、`errorKey` 和 `retryable`**：新接口用它们说明错误类别、具体说明和重试建议；不要把所有 `502` 都当作临时网络问题。
3. **QQ 的数字码**：想知道 QQ 实际说了什么，看[QQ 回的数字码是什么意思](#qq-回的数字码是什么意思)。没有取得的码不能补猜。
4. **播放才有**：`/getMusicPlay` 整体回 `200`，但里面每首歌可能各自拿不到链接，要逐首看 `restriction` 和 `hint`。

扫码登录的 `/login/qr/check` 用的是另一套状态（`800`～`803`），见最后一节。

## HTTP 状态码

| 状态码 | 意思 | 前端怎么做 |
| --- | --- | --- |
| `200` | HTTP 请求成功，业务结果还要检查正文。旧曲库接口可能带非零上游码，播放接口逐首给结果 | 按各接口说明检查正文 |
| `400` | 参数不对（`input.invalid`），请求没有送到 QQ | 修正请求，不要重试 |
| `401` | 没登录，或 QQ 不认这组登录凭证 | **清掉登录，请使用者重新扫码** |
| `405` | 写入类接口用了 GET | 改用 POST |
| `422` | QQ 回了成功，但确实没有数据（例如一首歌都没有） | 显示空状态，不是网络错误 |
| `429` | 请求太频繁 | 等 `retryAfterMs`（或 `Retry-After` 头）再试 |
| `501` | Serverless 部署没有这个接口，或没设 `QQ_SESSION_SECRET` | 不要重试，检查部署设置 |
| `502` | 连不到 QQ、QQ 拒绝了请求，或响应格式不对 | **不要清登录**。按 `kind`、`errorKey` 和 `retryable` 判断；写入类先读回确认结果 |
| `500` | 旧接口的上游错误，或服务自己出错 | 旧接口照原来的方式处理；新接口回报问题 |

新接口出错时的回应长这样（数字是示例）：

```json
{
  "code": 502,
  "kind": "upstream-business",
  "errorKey": "upstream.unknown",
  "message": "Upstream rejected the request",
  "retryable": false,
  "upstreamCode": 12345
}
```

`message` 是固定的英文说明，不会带 QQ 的原始内容或任何凭证。`upstreamCode` 是 QQ 回的数字码，只有拿得到时才出现，给排查用，不要直接拿来判断原因。

`kind` 区分错误类别，例如 `network`、`upstream-http`、`upstream-business`、`upstream-gateway`、`invalid-response`。同一个 `502` 可能是网络失败，也可能是上游明确拒绝；不能仅凭状态码判断是否该重试。字段的相容承诺见[相容与版本政策](./compatibility.md)。

## errorKey

红心写入默认启用，没有会话回 `401`；Serverless 未配置密钥仍回 `501`。
红心的写入或确认结果不明回 `502`，不会自动重送。

专辑收藏写入同样默认启用，没有会话回 `401`；Serverless 未配置密钥仍回 `501`。
专辑的写入或确认结果不明回 `502`，不会自动重送。

### 登录与会话

| errorKey | 状态码 | 意思 | 可以跟使用者说 |
| --- | --- | --- | --- |
| `auth.required` | 401 | 没带登录，或登录已经过期 | 请先登录 |
| `auth.credential-invalid` | 401 | QQ 不认这组登录凭证 | 登录已失效，请重新登录 |
| `auth.device-limit` | 502 | 登录的设备数到上限了 | 到 QQ 音乐的“登录设备管理”移除旧设备再扫码 |
| `auth.rate-limited` | 429 | 登录操作太频繁 | 稍等一下再试 |
| `auth.account-restricted`、`auth.account-banned`、`auth.account-binding` | 502 | QQ 拒绝这个账号登录 | “这个账号暂时无法登录”，不要说死是什么原因 |
| `auth.login-rejected` | 502 | QQ 拒绝了这次登录 | 登录被拒，请重试 |

### 网络与上游

| errorKey | 状态码 | 意思 | 前端怎么做 |
| --- | --- | --- | --- |
| `network.timeout`、`network.dns`、`network.refused`、`network.reset`、`network.aborted`、`network.unknown` | 502 | 服务连不到 QQ | 显示网络问题，读取类可以重试 |
| `upstream.http` | 502 | QQ 回了非 2xx 的 HTTP 状态 | 同上 |
| `upstream.gateway-rejected` | 502 | QQ 的网关拒绝了请求 | 不要清登录，稍后再试 |
| `upstream.unknown` | 502 | QQ 回了一个意思还没确认的错误码 | “服务暂时无法完成，请稍后再试” |
| `upstream.invalid-response` | 502 | QQ 的回应格式和预期不一样 | 同上 |
| `upstream.rate-limited` | 429 | QQ 限流 | 等冷却时间再试 |
| `resource.not-found` | 422 | QQ 说成功，但没有数据 | 显示空状态 |
| `internal.unexpected` | 500 | 服务自己出错 | 回报问题 |

### 歌单、推荐与收藏

| errorKey | 状态码 | 意思 |
| --- | --- | --- |
| `playlist.not-found` | 422 | 读的歌单不存在 |
| `playlist.anonymous-unreadable` | 502 | 这张官方歌单不登录读不到，要带登录再读 |
| `playlist.authentication-unverified` | 502 | 读歌单时 QQ 回了一个疑似和登录有关、但没确认的码，所以**不当成登录失效** |
| `playlist.already-applied` | 502 | QQ 说歌曲已经在（或不在）歌单里；不当成成功 |
| `playlist.write-rejected` | 502 | 歌单写入被 QQ 拒绝，原因不明 |
| `recommendation.rejected` | 502 | 推荐请求被 QQ 拒绝，原因不明 |
| `search.rejected` | 502 | 搜索被 QQ 拒绝（不登录搜歌曲时常见），不是搜不到；登录后再搜 |

Serverless（Vercel、Cloudflare）上的搜索还可能回 `200` 加空清单：QQ 对机房的网络有时回“成功、没有结果”而不是报错，服务分不出来，所以不会变成 `search.rejected`。要稳定搜索请用 Node、Docker 或 Electron（见使用文档）。

### 写入类接口出错时

建立、改名、删除歌单，加歌删歌，收藏歌单，这些接口**只送一次、不会自动重试**。普通歌单接口遇到参数不对、不是自己的歌单、动到“我喜欢”或系统歌单，一律回 `400`，而且**什么都没写**。

加歌删歌回 `changed: false` 时，额外的 `verification.status` 只描述读回状态：全部找到为 `present`，完整读回且全部不在为 `absent`，混合、读不完整或失败为 `unknown`。
核对最多读前 100 首一次，不翻页、不重试；即使核对被拒也保留原 HTTP `200` 与 `changed: false`，不会因此清登录或重新写入。
这不能证明没有变更的原因，也不要把 `present` 或 `absent` 当成 `changed: true`。

建立、改名、删除歌单时，如果写入已经送出去、但结果没办法确认，回应会多这几个字段：

| 字段 | 意思 |
| --- | --- |
| `writeAttempted: true` | 写入请求已经送出去了 |
| `verification: "unconfirmed"` | 没办法确认有没有写成功 |
| `retryable: false` | 不要直接再写一次 |

这时请先重新读一次歌单，确认实际情况再决定下一步。加歌删歌的成功无变更说明是 `verification: { status }`，与这里的错误字符串形状不同。
加歌删歌、收藏歌单回 `502` 时写入可能已经生效，先读回（歌单内容或 `/user/subscription-status`）再决定要不要重做。

## QQ 回的数字码是什么意思

QQ 出错时会回一个数字码。这个服务会把它原样交给你，让你知道 QQ 实际说了什么：

| 在哪里看 | 字段 |
| --- | --- |
| 新接口出错 | `upstreamCode`（有子码时另有 `upstreamSubCode`，QQ 网关层的码在 `upstreamGlobalCode`，QQ 的 HTTP 状态在 `upstreamHttpStatus`） |
| 扫码失败（`800`） | `upstreamCode`；走 MQTT 的手机 QQ 另看 `primaryFailure.upstreamCode`（Serverless 网页登录直接在顶层） |
| 播放某首拿不到链接 | `restriction.codes`（例如 `result`、`subcode`） |
| 旧接口回 `500` | `error` 文字里的 `failed (HTTP 200, global=…, code=…)`，`global` 是网关层的码、`code` 是业务码 |

下表是目前认得的码。**同一个数字在不同地方意思可能不一样**，所以一定要连“在哪里出现”一起看。“有多确定”那一栏：

- **实测过**：这个项目自己用真账号看到过，意思也对得上；
- **公开资料**：公开的协议资料这样说，这个项目还没亲手复现；
- **别人回报**：其他人回报过，原因没有分离；
- **沿用处理**：这个项目一直这样处理，没有单独实测。

| 数字码 | 在哪里出现 | 意思 | 有多确定 | 对应 errorKey |
| --- | --- | --- | --- | --- |
| `20279` | 扫码换凭证 | 账号的登录设备数满了 | 公开资料，社区多次回报 | `auth.device-limit` |
| `20277`、`20278` | 扫码换凭证 | 账号受限 | 公开资料 | `auth.account-restricted` |
| `20450` | 扫码换凭证 | 账号被封禁 | 公开资料 | `auth.account-banned` |
| `20272`、`20274` | 扫码换凭证 | 账号绑定有问题（异常或缺失） | 公开资料 | `auth.account-binding` |
| `20261` | 扫码换凭证 | 登录参数不被接受 | 公开资料 | `auth.login-rejected` |
| `104604` | 扫码换凭证 | 登录操作太频繁，冷却 30 秒 | 公开资料 | `auth.rate-limited` |
| `50006` | 手机 QQ 扫码换凭证 | 被拒，原因不明。见过一次是用 QQ 音乐 App 扫了手机 QQ 的码 | 实测过，但只有一个样本 | （不分类） |
| `1000` | 手机 QQ 换凭证失败后的再验证 | 再验证也被拒；**不代表登录失效**，真正原因看 `primaryFailure` | 实测过 | （不分类） |
| `1000`、`104400`、`104401` | 登录后的读取（资料、歌单、推荐、电台、每日 30 首等） | QQ 不认这组登录凭证，回 `401` | 沿用处理 | `auth.credential-invalid` |
| `22006` | 猜你喜欢 | 推荐请求被拒，原因没有分离 | 实测过 | `recommendation.rejected` |
| `2001` | 关键字搜索 | 搜索被拒，常见于不登录搜歌曲，原因没有分离 | 实测过 | `search.rejected` |
| `10` | 不登录读歌单详情 | 这张是按账号生成的官方歌单，要带登录才读得到（服务会自己带登录重读） | 实测过 | `playlist.anonymous-unreadable` |
| `10004` | 登录后读歌单详情 | 歌单不存在 | 实测过 | `playlist.not-found` |
| `80120` | 读歌单详情 | 疑似和登录有关，但没确认，所以**不回 401** | 实测过 | `playlist.authentication-unverified` |
| `80092` | 歌单加歌、删歌 | 歌曲已经在（或不在）歌单里；不当成成功 | 公开资料，实际写入时没见过 | `playlist.already-applied` |
| `80105` | 往“我喜欢”加歌 | 被拒，原因不明 | 别人回报 | `playlist.write-rejected` |
| `2001` | 歌单删歌 | 原因不明；不当成功，也不当限流 | 实测过一次 | （不分类） |
| `104003`（`subcode` `1`） | 播放某首拿不到链接 | **这首、这个音质、这一次**没给链接。没有这个音质的文件、账号没有权益、所在地区被挡都长这样，单看数字分不出来，原因请看 `hint` | 实测过 | （看 `hint`） |

没列在表里的码，意思都还没确认：新接口会回 `502`、`errorKey` 是 `upstream.unknown`，数字原样放在 `upstreamCode`，方便你回报或自己对照，但不要拿它猜原因。

## 播放：每首歌的结果

`/getMusicPlay` 回 `200` 时，`data.playUrl` 里每首歌各自是：

- **拿到了**：有 `url`。试听拿到时多 `preview: true`；用 `quality=best` 时多 `quality`，告诉你实际拿到哪一级音质。
- **没拿到**：`url` 是空的，多一个 `restriction`。机器判断用的 `restriction.key` 一律是 `url_unavailable`；给人看的原因放在可选的 `hint: { key, message }`。

| `hint.key` | 什么时候出现 | 可以跟使用者说 |
| --- | --- | --- |
| `playback.reason-unconfirmed` | 拿不到链接，原因判断不出来（登录后的 `m4a`／`128` 会先自动再取一次） | 暂时无法播放，原因尚未确认（可能已下架，或被风控） |
| `playback.maybe-region-restricted` | 登录后标准音质也拿不到，而且符合实测过的地区限制特征 | 这首歌**可能**受所在地区的版权限制 |
| `playback.maybe-membership` | 登录后标准音质也拿不到，而且符合实测过的会员权益特征 | 完整播放**可能**需要会员 |
| `playback.preview-missing` | 要试听，但这首确定没有试听文件（只在登录时给） | 这首歌没有试听；免费账号可以建议升级会员 |
| `playback.preview-unavailable` | 要试听，但没办法确认有没有试听文件，或要了没给 | 试听暂时不可用 |
| `playback.quality-file-unavailable` | 要 `ape`，但这首没有这个音质的文件 | 这个音质没有文件，换别的音质 |
| `playback.quality-detail-unavailable` | 要 `ape`，但查不到这首有没有这个文件 | 这个音质暂时无法确认，稍后再试 |

几个要注意的地方：

- **“可能”就是可能**：地区、会员两种提示只有完整特征都对得上才会给，文案也保留“可能”。其他情况一律是“原因尚未确认”，不会乱猜下架、会员或地区。
- **高音质拿不到，不代表低音质也拿不到**：`320`、`flac` 失败时，前端可以自己退回 `128`，或直接用 `quality=best`。
- **不要拿会员等级判断能不能播**：免费账号领了听歌时长，也可能拿到完整的歌。一切以这次有没有拿到 `url` 为准。
- **再取一次**：登录后用 `m4a`／`128`（包括 `quality=best` 的最后一级）拿不到、原因又判断不出来时，服务会马上再要一次，每首最多多一次。前端不用再为同一个音质重试。
- 设 `QQ_PLAYBACK_HINTS_ENABLED=0` 可以关掉地区和会员两种具体提示，全部变成“原因尚未确认”。
- **提示依据的样本不多**：地区和会员两种特征都来自少量歌曲的实测。同一首歌的特征可能随时间、所在地区或曲目状态（例如限时免费）改变，对不上时会退回“原因尚未确认”。所以“原因尚未确认”也可能是地区或会员造成的。
- **加密文件接口**：`/getEncryptedMusicPlay` 拿不到链接时，一律是 `playback.reason-unconfirmed`，不给地区或会员提示；`restriction.codes` 会带上游的结果码。上游回了成功码，但链接或密钥对不上请求的歌、音质时，也会回空链接，这时 `codes.result` 可能是 `0`。没登录回 `401`；参数不对回 `400`；超过 15 秒回 `502`（`network.timeout`）。

## 扫码登录的状态

`/login/qr/check` 回的 `code`：

| code | 意思 |
| --- | --- |
| `801` | 等待扫码 |
| `802` | 已扫码，等手机上确认 |
| `803` | 登录成功，回应带登录会话 |
| `800` | 二维码过期，或这次登录失败 |

`800` 要分两种看：

- **自然过期**：不带下面这些诊断字段，直接请使用者重新拿一张二维码。
- **登录失败**：会带 `failureStage`（哪一步失败）、`failureReason`（固定的原因）、`upstreamCode`（QQ 的数字码）。认得出原因时还会有：
  - `upstreamErrorKey`：对应上面“登录与会话”那张表；
  - `failureHint: { key, message }`：可以直接给使用者看的说明，`key` 有 `login.device-limit`（登录设备已满）、`login.wrong-scan-app`（可能用 QQ 音乐 App 扫了手机 QQ 的二维码，建议登录方式改选 QQ 音乐 App，或改用手机 QQ 扫）、`login.rate-limited`、`login.account-restricted`、`login.account-banned`、`login.account-binding`、`login.rejected`。

手机 QQ 扫码失败时还可能有 `primaryFailure` 和 `fallbackAttempted: true`。这是因为服务换凭证失败后会再验证一次，顶层字段写的是最后这次的结果；真正的原因（例如登录设备已满）要看 `primaryFailure`。Serverless 没有中继时，手机 QQ 走网页登录，没有这次再验证：换凭证被拒的 `upstreamCode`、`upstreamErrorKey` 和 `failureHint` 直接在顶层。

## 重试与冷却

| 情况 | 规则 |
| --- | --- |
| 使用共用请求核心的读取类请求 | 网络错误或部分 5xx 最多重试 2 次，单次请求超时 25 秒；旧接口和登录流程各有规则，不能统一套用 |
| 写入类请求 | 一律不重试；结果不明时先读回确认 |
| 扫码失败 | 要等 15 秒才能拿新的二维码；QQ 明确说操作太频繁时等 30 秒 |
| 播放拿不到链接 | 只在上面“再取一次”的条件下多要一次 |
