# QQ Music API 使用文档

QQ Music API 是一个基于 **Koa2 + TypeScript** 的非官方 QQ 音乐 API，支持独立部署，也可以嵌入 Node.js、Electron 和 Serverless 运行环境。

提供扫码登录、歌曲搜索、播放链接、个人音乐库、歌单管理、推荐、电台、歌词及 MV 等功能。

> **适用版本：3.3.5**
>
> - 项目主页：[QQ Music API](../README.md)
> - 接口错误：[错误对照表](./errors.md)
> - 版本兼容：[兼容性政策](./compatibility.md)
> - 更新记录：[CHANGELOG](../CHANGELOG.md)
>
> 本文示例使用虚构的歌曲、歌单和账号标识，请以实际 API 返回的数据为准。

## 目录

- [快速开始](#快速开始)
- [部署与运行环境](#部署与运行环境)
- [配置说明](#配置说明)
- [扫码登录与会话管理](#扫码登录与会话管理)
- [API 接口一览](#api-接口一览)
- [核心功能说明](#核心功能说明)
- [错误处理](#错误处理)
- [旧接口与升级指南](#旧接口与升级指南)
- [项目架构与开发](#项目架构与开发)
- [常见问题](#常见问题)

---

## 快速开始

### 从源码启动

需要 **Node.js 20+** 和 npm。

```bash
git clone https://github.com/yakult-green-tea/qq-music-api.git
cd qq-music-api
npm ci
npm start
```

服务默认运行在：

- API 地址：`http://localhost:3200`
- API Explorer：`http://localhost:3200/explorer`

也可以通过 npm 安装：

```bash
npm install @yakult-green-tea/qq-music-api
node node_modules/@yakult-green-tea/qq-music-api/dist/src/app.js
```

如需固定版本，建议使用对应的 Release Tag，不要直接依赖尚未发布的开发分支。

### API Explorer

项目内置可视化接口调试工具，无需额外安装 Swagger 或其他服务。

支持接口搜索、GET/POST 筛选、参数填写、请求发送、响应查看和当前页面会话的请求日志。

![API Explorer](./explorer-overview.png)

Explorer 根据 `/explorer/metadata` 自动生成接口表单。

设置 `AUTO_OPEN_EXPLORER=true`，服务启动后会尝试自动打开浏览器。

---

## 部署与运行环境

### 支持的运行方式

| 环境 | 接入方式 | 会话模式 |
| --- | --- | --- |
| Node.js | 独立 HTTP 服务 | `stored` |
| Docker | 容器化部署 | `stored` |
| Electron | 嵌入主进程 | `stored` |
| Vercel | Serverless 请求入口 | `sealed` |
| Cloudflare Workers | Serverless 请求入口 | `sealed` |

### Docker 部署

在项目根目录执行：

```bash
npm run build:local-images
npm run run:images
```

默认映射本机 `3200` 端口。

使用 `qq-music-api-state` 命名卷保存设备身份和加密会话，重建容器时应复用相同的卷和 `QQ_SESSION_SECRET`。

未设置密钥时，会话仅保存在内存，重启后需要重新扫码。

镜像基于 Node.js 24 构建，构建命令不会自动上传镜像。

### Serverless 接入

项目提供独立的 Serverless 入口：

```js
import handleRequest from '@yakult-green-tea/qq-music-api/serverless';

export default {
  fetch(request, env) {
    return handleRequest(request, env);
  },
};
```

适用于使用标准 Web `Request` / `Response` 的运行时。

宿主负责：

- 提供 `QQ_SESSION_SECRET` 等环境变量。
- 将请求交给 `handleRequest`。
- 按需处理 CORS、OPTIONS 预检及访问控制。
- 使用 MQTT 登录时自行提供 `qqRelay` 中继。

Vercel 使用对应运行时的入口转接到同一处理函数。

### 登录通道支持

| 登录通道 | Node / Docker / Electron | Serverless 无中继 | Serverless 有中继 |
| --- | --- | --- | --- |
| `qq` 手机 QQ | MQTT | ptlogin HTTP | MQTT |
| `wechat` 微信 | 支持 | 支持 | 支持 |
| `qqmusic` QQ 音乐 App | MQTT | 不支持 | MQTT |

**注意：**

- Serverless 无中继时，`qq` 默认使用 QQ 网页登录流程。
- `qqmusic` 使用 MQTT，需要宿主提供长连接中继。
- Cloudflare Workers 可以使用 Durable Object 承载中继。
- 设置 `QQ_PTLOGIN_HTTP_ENABLED=0` 可关闭无中继时的手机 QQ 网页登录。
- 实际支持的通道应以 `GET /login/channels` 返回结果为准。

### Serverless 使用限制

**搜索与播放**

Serverless 请求由部署平台的网络出口发送，可能与用户本地网络得到不同的上游结果。

已观察到以下情况：

- 搜索返回 HTTP `200`，但结果为空。
- 同一账号本地可获取播放链接，Serverless 却返回空链接。
- 部分歌曲在官方客户端可以播放，但通过部署服务无法取链。

这些现象尚不能统一归因于地区、会员或版权限制，也不能保证更换部署方式一定解决。

**会话与设备**

- Serverless 需要稳定的 `QQ_SESSION_SECRET`。
- 更换密钥可能改变派生的设备身份，占用新的登录设备名额。
- Serverless 的 sealed token 无法在登出后立即由服务端撤销。
- 登录会话需要客户端主动续期。

---

## 配置说明

### 常用环境变量

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3200` | HTTP 服务端口 |
| `QQ_SESSION_SECRET` | 未设置 | Serverless 或持久会话的加密密钥 |
| `QQ_SESSION_SECRET_PREVIOUS` | 未设置 | 密钥轮换时读取旧会话 |
| `QQ_AUTH_STATE_PATH` | `.auth-state/qq-device.json` | 设备身份存储路径 |
| `QQ_AUTH_SESSION_PATH` | 内存 | Node 加密会话文件路径 |
| `QQ_PTLOGIN_HTTP_ENABLED` | 开启 | Serverless 无中继时是否启用手机 QQ 网页登录 |
| `QQ_WECHAT_POLL_BUDGET_MS` | `15000` | Node 微信扫码单次检查等待上限，单位毫秒 |
| `QQ_PLAYBACK_HINTS_ENABLED` | 开启 | 是否启用具体播放失败提示及额外查询 |
| `AUTO_OPEN_EXPLORER` | `false` | 启动时自动打开 Explorer |
| `LOG_LEVEL` | `info` | Node 日志级别 |
| `QQ_ENABLE_UPDATE_CHECK` | `false` | 启动时检查 npm 新版本 |
| `QQ_DISABLE_UPDATE_CHECK` | `false` | 强制关闭版本检查 |
| `QQ_UNVERIFIED_WRITES_ENABLED` | 关闭 | 预留的实验写入开关，目前已开放的写入接口不依赖它 |

### 会话安全

`QQ_SESSION_SECRET` 应使用独立生成的高强度随机密钥，并通过部署平台的密钥管理功能注入。

建议：

- 不要将密钥提交到 Git。
- 不要在日志中记录 Cookie、token 或完整播放链接。
- 长期运行的部署保持密钥稳定。
- 使用文件会话仓库时确保内容加密。
- 多实例部署不要直接共用同一个设备身份文件。

---

## 扫码登录与会话管理

### 登录流程

项目支持手机 QQ、微信及 QQ 音乐 App 扫码，具体通道取决于部署环境。

| 步骤 | 接口 | 说明 |
| --- | --- | --- |
| 1 | `GET /login/channels` | 获取可用通道和会话模式 |
| 2 | `GET /login/qr/key?channel=qq` | 获取二维码标识 `unikey` |
| 3 | `GET /login/qr/create?key=...` | 获取二维码图片 |
| 4 | `GET /login/qr/check?key=...` | 轮询扫码状态 |
| 5 | `GET /login/status` | 查询登录状态 |
| 6 | `POST /login/refresh` | 按需续期 |
| 7 | `GET /logout` | 退出登录 |

`channel` 支持：

- `qq`：手机 QQ 扫码，兼容旧参数 `mobile`。
- `wechat`：微信扫码。
- `qqmusic`：QQ 音乐 App 扫码，使用 App 当前登录的账号。

二维码通过 `data.qrimg` 返回，客户端应按 data URL 的实际 MIME 类型显示，不要固定假设为 PNG。

### 扫码状态码

| 状态码 | 含义 |
| --- | --- |
| `801` | 等待扫码 |
| `802` | 已扫描，等待确认 |
| `803` | 授权成功 |
| `800` | 二维码过期或登录失败 |

`800` 可能代表不同失败原因，需要结合诊断字段判断。

需要取消二维码时，调用 `GET /login/qr/cancel`。

取消、退出登录和过期是三件分开的事：`/login/qr/cancel?key=` 只取消这一个二维码；`/logout` 只退出当前带的会话，不会取消别的正在进行的扫码。手机上已经确认、还在换凭证时被取消的，换完不会发会话。已确认的二维码在有效期过后还会保留 60 秒，轮询照样拿得到 `803`；这段时间里一直没有被轮询领走的登录会被撤销。轮询时遇到意外错误回 `800`、`QR login failed`，并带 `failureStage: qr-poll`、`failureReason: unexpected-error`；只有找不到这个二维码才回 `QR code expired`。

### 登录会话

成功后可以使用以下方式携带会话：

```http
X-QQ-Session: <token>
```

Node 环境也支持 HttpOnly Cookie：

```text
qqmusic_session=<token>
```

请保护好会话 token，不要公开带有会话参数的请求 URL。

### 会话模式与续期

| 项目 | `stored` | `sealed` |
| --- | --- | --- |
| 适用环境 | Node / Docker / Electron | Serverless |
| 凭证存放 | 服务端仓库 | 加密 token |
| 自动续期 | 有请求时自动处理 | 客户端主动请求 |
| token 轮换 | 通常不变 | 可能返回新 token |
| 登出 | 服务端撤销会话 | 清除客户端 token，旧 token 不立即失效 |

两种模式都支持：

```http
POST /login/refresh
```

成功示例：

```json
{
  "code": 200,
  "data": {
    "token": "<session-token>",
    "rotated": true,
    "expiresAt": 1790000000000
  }
}
```

仅在凭证距离到期不足约 6 小时时尝试续期。

对于 Serverless：

- `rotated: true` 时，客户端必须保存新 token。
- 从首次扫码开始，最多续期 30 天。
- 超过期限后需要重新扫码。
- 失败后同一实例内通常会等待 5 分钟再尝试。

对于 Node：

- 有请求进入且符合条件时自动续期。
- 旧会话尚有效时，续期失败不会立即要求重新登录。
- 未包含有效续期材料的凭证无法续期。

### 扫码失败诊断

登录失败时，可关注以下字段：

| 字段 | 作用 |
| --- | --- |
| `failureStage` | 失败发生的步骤 |
| `failureReason` | 网络、超时等固定错误原因 |
| `upstreamCode` | 上游返回的数字码 |
| `upstreamErrorKey` | 已确认的上游错误分类 |
| `failureHint` | 可提供给用户的提示 |
| `retryAfterMs` | 建议等待时间 |
| `primaryFailure` | MQTT 换凭证失败后的原始失败摘要 |
| `fallbackAttempted` | 是否尝试备用验证 |

常见提示包括：

- `login.device-limit`：登录设备达到上限。
- `login.rate-limited`：操作过于频繁。
- `login.wrong-scan-app`：扫码 App 或账号类型不匹配。
- `login.account-restricted`：账号受限。
- `login.rejected`：登录被拒绝。

未确认的上游数字码不会被强行归类。

一般扫码失败会短暂退避约 15 秒；明确触发上游频率限制时约为 30 秒。

---

## API 接口一览

接口按功能分类。需要登录的接口应携带有效会话。

除特别注明外，本节的新式接口在 Node 和 Serverless 均提供相应实现，但实际结果仍取决于会话、部署配置和 QQ 上游响应。

### 登录与用户

| 接口 | 说明 | 登录 |
| --- | --- | --- |
| `/login/channels` | 登录通道与能力声明 | 否 |
| `/login/qr/key` | 获取二维码标识 | 否 |
| `/login/qr/create` | 创建二维码 | 否 |
| `/login/qr/check` | 检查扫码状态 | 否 |
| `/login/qr/cancel` | 取消扫码 | 否 |
| `/login/status` | 查询登录状态 | 是 |
| `/login/refresh` | 会话续期，POST | 是 |
| `/logout` | 退出登录 | 是 |
| `/user/detail` | 用户资料 | 是 |
| `/user/vip` | 会员状态 | 是 |
| `/user/music-gene` | 本人音乐基因 | 是 |

### 搜索与曲库

| 接口 | 说明 | 登录 |
| --- | --- | --- |
| `/search` | 搜索歌曲、专辑、歌单、歌手 | 可选 |
| `/search/hot` | 热搜关键词 | 否 |
| `/search/suggest` | 搜索建议 | 否 |
| `/search/match` | 搜索直接命中的歌曲、歌手、专辑与 MV | 否 |
| `/search/users` | 搜索用户 | 是 |
| `/song/batch` | 批量歌曲详情，POST | 否 |
| `/song/fav-count` | 歌曲收藏数 | 否 |
| `/song/versions` | 歌曲其他版本 | 否 |
| `/getSongInfo` | 歌曲资料 | 否 |
| `/getAlbumInfo` | 专辑详情 | 否 |
| `/getLyric` | 歌词与翻译 | 否 |
| `/getMusicPlay/:songmid` | 获取音频播放链接 | 可选* |
| `/song/labels` | 歌曲标签 | 否 |

*Serverless 的播放接口需要有效登录会话。

### 推荐与电台

| 接口 | 说明 | 登录 |
| --- | --- | --- |
| `/user/guess-you-like` | 猜你喜欢 | 是 |
| `/user/guess-you-like/modes` | 猜你喜欢单选听歌模式目录（只读，待更多账号验收） | 是 |
| `/user/daily-songs` | 每日 30 首 | 是 |
| `/user/personal-fm` | 私人 FM 批次（待真账号验收） | 是 |
| `/recommend/playlists` | 推荐歌单 | 可选 |
| `/recommend/radar` | 刷歌模式 | 可选 |
| `/recommend/categories` | 热门歌单分类 | 否 |
| `/recommend/categories/all` | 完整歌单分类 | 否 |
| `/recommend/category-playlists` | 分类歌单 | 否 |
| `/recommend/category-playlists/sorted` | 按指定排序读取分类歌单 | 否 |
| `/recommend/new-songs` | 新歌速递 | 否 |
| `/recommend/new-albums` | 新碟上架 | 否 |
| `/recommend/toplists` | 排行榜列表 | 否 |
| `/recommend/toplist` | 排行榜歌曲 | 否 |
| `/radio/categories` | 匿名电台分类 | 否 |
| `/radio/list` | 账号电台列表 | 是 |
| `/radio/tracks` | 电台歌曲 | 是 |
| `/radio/recommendation-modes` | 普通官方雷达单选 radio ID 选项（待真账号验收） | 是 |
| `/radio/recommendation-tracks` | 普通官方雷达批次（待真账号验收） | 是 |
| `/song/similar` | 相似歌曲 | 是 |
| `/song/related-playlists` | 包含指定歌曲的相关歌单 | 是 |

### 个人音乐库

| 接口 | 说明 |
| --- | --- |
| `/user/playlist` | 自建与收藏歌单 |
| `/user/playlist-detail` | 本人歌单详情，包含不公开歌单 |
| `/user/liked-songs` | 我喜欢的歌曲 |
| `/user/albums` | 收藏专辑 |
| `/user/cloud` | 音乐云盘 |
| `/user/subscription-status` | 歌曲、歌单及专辑收藏状态 |

以上接口均需要登录。

### 歌单与收藏管理

以下均为需要登录的接口：

| 接口 | 方法 | 说明 |
| --- | --- | --- |
| `/user/playlist/create` | POST | 创建普通歌单 |
| `/user/playlist/rename` | POST | 修改普通歌单名称 |
| `/user/playlist/delete` | POST | 删除普通歌单 |
| `/user/playlist/tracks` | POST | 添加、删除歌单歌曲 |
| `/user/playlist/subscribe` | POST | 收藏或取消收藏歌单 |
| `/user/song/like` | POST | 添加、取消红心 |
| `/user/album/subscribe` | POST | 收藏或取消收藏专辑 |

### 歌手与 MV

| 接口 | 说明 |
| --- | --- |
| `/singer/list` | 歌手列表与分类筛选 |
| `/singer/detail` | 歌手详细资料 |
| `/singer/homepage` | 粉丝数、关注数 |
| `/singer/similar` | 相似歌手 |
| `/singer/songs` | 歌手歌曲 |
| `/singer/mvs` | 歌手 MV |
| `/mv/list` | MV 列表 |
| `/mv/detail` | MV 详情 |
| `/mv/url` | MV 播放链接 |
| `/song/mvs` | 歌曲相关 MV |

以上接口支持匿名访问；`/mv/url` 也可以携带会话获取上游允许的更多画质。

### 评论

| 接口 | 说明 |
| --- | --- |
| `/comment/hot` | 歌曲热门评论 |
| `/comment/new` | 歌曲最新评论 |
| `/comment/count` | 歌曲评论数量 |
| `/comment/list` | 通用资源评论及回复，支持游标 |

以上接口不需要登录。

### 保留的旧曲库接口

为了兼容已有调用方，以下接口继续保留：

| 接口 | 说明 |
| --- | --- |
| `/getSongListDetail` | 歌单详情 |
| `/getAlbumInfo` | 专辑详情 |
| `/getSingerAlbum` | 歌手专辑 |
| `/getSingerHotsong` | 歌手热门歌曲 |
| `/getSongInfo` | 歌曲资料 |
| `/getMusicPlay` | 播放链接 |
| `/getLyric` | 歌词 |

旧接口并未全部迁移到新的错误响应格式，调用方可能仍需检查 HTTP `200` 响应中的上游业务码。

---

## 核心功能说明

### 1. 搜索

```http
GET /search?keyword=示例&type=song&page=1&limit=10
```

支持以下类型：

| `type` | 搜索内容 |
| --- | --- |
| `song` | 歌曲，默认 |
| `album` | 专辑 |
| `playlist` | 歌单 |
| `singer` | 歌手 |

`keyword` 最多 60 个字符，`page` 从 1 开始，`limit` 默认 10、最多 20。

搜索成功返回：

```json
{
  "code": 200,
  "type": "song",
  "page": 1,
  "total": 36,
  "more": true,
  "items": []
}
```

**注意：**

- 搜索不到时可以返回 `200` 和空列表。
- 上游拒绝请求时可能返回 `502`，不等于没有搜索结果。
- Serverless 的网络出口可能影响搜索结果。

`/search/match` 用于直接命中歌曲、歌手、专辑、MV 等实体；`/search/suggest` 只返回搜索词建议。

### 2. 播放链接与音质

```http
GET /getMusicPlay/demo-song-mid?quality=best
```

支持的音质：

| 参数 | 说明 |
| --- | --- |
| `m4a` | M4A |
| `128` | 128K |
| `320` | 320K |
| `flac` | FLAC |
| `ape` | APE |
| `best` | 最高可用音质 |

`quality` 默认 `128`。

使用 `quality=best` 时，带有效会话的请求会按照已知文件信息尝试：

`FLAC → 320K → 128K`

获取成功后停止；匿名请求通常直接使用 `128`。

其他常用参数：

- `resType=play`：仅播放结果，默认。
- `resType=all`：完整结果。
- `preview=1`：请求试听文件。拿到链接的条目会带 `"preview": true`；`file.size_try` 大于 0 代表有试听文件，不代表文件大小。
- `mediaId`：指定可信的媒体文件标识。

`best` 不保证取得无损音质，实际结果以账号权限、文件存在情况与上游响应为准。

#### 播放失败说明

上游没有提供播放链接时，响应可能包含：

```json
{
  "url": "",
  "restriction": {
    "key": "url_unavailable",
    "evidence": "observed-response",
    "hint": {
      "key": "playback.reason-unconfirmed",
      "message": "This song can't be played right now. The exact reason isn't confirmed yet."
    }
  }
}
```

`url_unavailable` 仅代表当前请求没有获得链接，**不代表已经确认是会员、地区或版权问题**。

在特定已验证条件下，可能出现：

- `playback.maybe-region-restricted`
- `playback.maybe-membership`
- `playback.preview-missing`
- `playback.preview-unavailable`
- `playback.quality-file-unavailable`

其中 `maybe-*` 只是提示，不是确定结论。

对于符合条件且原因尚未确认的登录态请求，服务可能自动重新取链一次。试听、匿名请求和部分音质不会使用该重试。

设置 `QQ_PLAYBACK_HINTS_ENABLED=0` 可以关闭具体原因提示和对应的额外查询，但不关闭既有的取链逻辑。

### 3. 歌词

```http
GET /getLyric?songmid=demo-song-mid&trans=1
```

支持：

- 普通 LRC 歌词。
- `isFormat=1`：格式化歌词。
- `trans=1`：尝试补充翻译。

并非所有歌曲都有翻译。缺失翻译不会影响主歌词返回。

### 4. 个人歌单

不同歌单需要使用不同接口：

| 歌单类型 | 推荐接口 |
| --- | --- |
| 我喜欢 | `/user/liked-songs` |
| 本人自建歌单 | `/user/playlist-detail` |
| 本人不公开歌单 | `/user/playlist-detail` |
| 收藏的其他用户歌单 | `/getSongListDetail` |

`/user/playlist` 只允许读取当前登录账号，不支持任意其他用户的个人音乐库。

`/user/playlist-detail` 建议传入 `tid`；也支持当前账号自己的 `dirid`。

如需播放数，可以增加：

```http
GET /user/playlist?playCount=1
```

播放数可能使用最长约 10 分钟的缓存。未能核实的播放数不会填成 `0`；`playCountComplete` 用于判断本次补充数据是否完整。

收藏歌单的续读可使用返回的 `nextFavoriteOffset`，不要在没有续读游标时无限请求。

### 5. 歌单与收藏写入

创建歌单：

```http
POST /user/playlist/create
```

```json
{
  "name": "我的歌单"
}
```

修改歌单名称：

```json
{
  "tid": "70001",
  "name": "新的歌单名称"
}
```

添加歌曲：

```http
POST /user/playlist/tracks
```

```json
{
  "tid": "70001",
  "op": "add",
  "songs": [
    {
      "id": 101,
      "type": 0
    }
  ]
}
```

`op` 支持 `add` 和 `del`，每次 1–100 首，仅支持经过明确确认的普通歌曲类型 `0`。写入成功返回 `{ code: 200, changed: true }`；上游明确报告没有变化时为 `changed: false`，不能据此推断原因。

红心操作：

```http
POST /user/song/like
```

```json
{
  "song": {
    "id": 101,
    "mid": "demoSongMid",
    "type": 0
  },
  "liked": true
}
```

收藏专辑：

```http
POST /user/album/subscribe
```

```json
{
  "id": "demoAlbumMid",
  "subscribed": true
}
```

**所有写入接口都遵循安全原则：**

- 限制操作范围为当前账号有权限的资源。
- 写入不自动重试，避免重复或误操作。
- 对需要确认的操作进行写后读回。
- 状态不明确时，不直接当作成功。
- 失败后应先查询当前状态，再决定是否重试。

歌单创建、删除、改名和普通歌曲增删有各自的验证边界。客户端不能绕过服务端目标校验。

### 6. 会员状态

```http
GET /user/vip
```

`vipLevel` 分为：

| 值 | 含义 |
| --- | --- |
| `super` | 超级会员 |
| `green` | 绿钻会员 |
| `free` | 免费账号 |
| `unknown` | 无法确认 |

`unknown` 不能当作免费账号。

会员等级也不能直接决定歌曲是否可播放，最终仍以实际音源获取结果为准。

### 7. 音乐云盘

```http
GET /user/cloud?offset=0&limit=200
```

需要登录。

响应提供云盘歌曲、文件名、添加时间及分页信息。

`playable: true` 表示可尝试使用歌曲 MID 调用播放接口；`false` 表示当前仅能提供文件资料，不保证能够取到播放链接。

每次 `limit` 默认 200、最多 1000。

### 8. 推荐、电台与排行榜

常用调用：

```http
GET /user/personal-fm?page=1
GET /user/guess-you-like
GET /user/daily-songs
GET /recommend/playlists
GET /recommend/radar?page=1
GET /radio/list
GET /radio/tracks?id=99
GET /recommend/toplists
GET /recommend/toplist?id=26
```

使用说明：

- 猜你喜欢和每日 30 首需要登录。
- 推荐歌单与刷歌模式允许匿名使用，但登录可能影响推荐内容。
- `/radio/list` 和 `/radio/tracks` 需要登录。
- `/radio/categories` 可以匿名读取分类。
- 排行榜支持 `period`、`offset`、`limit` 等参数。
- 新歌、新碟和歌单分类支持各自的地区、分类或分页参数。

推荐列表的 `more` 不一定代表服务提供了连续游标。具体分页方式应按对应接口处理。

`features.recommendations.personalFmModes` 为 `false`：已有取歌接口不代表能处理 mode/submode。猜你喜欢的动态模式是独立能力，不能用此旗标代替；历史和屏蔽的未验能力同样保持关闭。

#### 私人 FM 批次

`GET /user/personal-fm?page=1` 需要可解析的登录会话；Serverless 未配置密钥回 `501`。此路径复用雷达协议，与 `/user/guess-you-like` 的 id 99 分开，不改变原有匿名 `/recommend/radar`。

- `page` 省略时为 1；只接受 1–100 的十进制整数，不接受空串、小数、前导零或越界值，不把越界页压回第 100 页。
- 成功回 `{ code: 200, station: "personal-fm", page, songs, more, nextPage? }`。曲目数量由上游决定，不固定为 5 或 10 首。
- `more: true` 且未到本地上限时给 `nextPage`；第 100 页仍有更多时给 `paginationLimitReached: true`，不提供下一页，也不把它说成上游结束。
- 空批次回 `422`；条目存在但无法解析回 `502`。失败只请求一次，调用方不能假定超时或取消代表上游未消耗批次。
- 服务不保存跨请求的批次位置。调用方按账号与来源隔离页序，预览、并发提交与晚到应答由自己的控制器处理，不能只为卡片封面消耗批次。
- 此路由已提供离线契约测试；手机入口对应仍为强候选，当前 Android comm、账号个性化及连续批次仍待真账号验收。

#### 每日30首历史

`GET /user/daily-songs/history/dates` 返回 `{ code: 200, dates: ["2026-11-01", "2026-10-27"] }`，示例日期为虚构数据。列表保留上游顺序，日期可能不连续；不从本地日历生成缺日，不把 `bSet` 解释为收藏状态。

`GET /user/daily-songs/history?date=2026-10-27` 返回 `{ code: 200, date, songs }`。日期必须是真实的 `YYYY-MM-DD` 日历日期；歌曲从上游 `songlist[].track` 读取，不补到30首。

两条路由只读当前会话本人，Serverless 未配置密钥回 `501`；会话缺失或无法解析回 `401`，无日期或无歌曲回 `422`，结构损坏回 `502`。新上游业务码尚未验证时保留 `502` 与安全的 `upstreamCode`，不猜测为登录失效。每次只发一次上游请求，不自动重试。

历史查询不创建或编辑普通歌单，不提供整份历史收藏。日期生成条件、保留期限、跨日更新时间及 API Android comm/session 尚待验证；`features.recommendations.getHistoryDates/getHistorySongs` 保持关闭。

#### 普通官方雷达选项与批次（未发布候选）

两条路径都需要有效会话；Serverless 未配置密钥回 `501`。它们与旧 `/radio/list`、`/radio/tracks` 分开，保留旧路径的上游与回包。私人 FM、每日30首、id 99 猜你喜欢不改为这个来源。

- `GET /radio/recommendation-modes` 返回 `{ code:200, selection:"single", modes:[{radioId,title,cover}], coverage:"first-page", complete:false }`。选项来自 `GetRecRadioList`，没有当前选中／永久保存状态；不支持分页，不把首屏当完整目录。
- `GET /radio/recommendation-tracks?id=91001` 返回 `{ code:200, station:"official-radio", radioId, title, songs, extras? }`。编号为虚构示例；`id` 必须为正的安全整数，`99` 仍走 `/user/guess-you-like`。请求上游一批，曲数由上游决定，不保证恰好五首，也不提供猜测的游标或结束标志。
- 单选后请求对应 radio ID 是取歌，不是 `UpdateRadioSceneConfig` 或音乐偏好写入；radio ID 与 id99场景目录／pool、偏好key、风格复合键不能互换。
- 不接受 `page`、`cursor`、`mode`、`submode`、`scene_id`。成功却无内容回 `422`；失败不重试，未知业务码保留 `502`，不会凭新RPC的1000清登录态。
- 已完成合成上游的跨宿主契约，并有一个经通用QR取得的微信账号的只读成功样本：目录9项、选定目录ID取歌5首。最小参数与Android comm仅在此样本可用，其他账号、ID和宿主仍待验收；没有因此启用Folia模式能力或新增设置保存接口。

#### 猜你喜欢听歌模式目录（未发布候选）

`GET /user/guess-you-like/modes` 需要有效会话；Serverless 未配置密钥回 `501`。只读 id 99 的 RadioConfig 目录，不改变 `/user/guess-you-like` 的取歌行为。

- 返回 `{ code:200, station:"guess-you-like", radioId:99, selection:"single", primaryModes, scenes, recommended, selectedIds }`。三组条目都是 `{ id, name, cover, poolId? }`；`selectedIds` 是上游给出的当前选中项，可以为空。
- `id` 是模式目录编号，`poolId` 只是取歌端的对照值；两者都不能当普通雷达 radio ID、音乐偏好 key 或风格黑名单编号使用。上游的状态、时间、排序字段含义未确认，不对外返回。
- 不接受 `id`、`page`、`cursor`、`mode`、`scene_id`、`pool_id`。目录为空回 `422`；失败不重试，未知业务码保留 `502`，不会凭新RPC的1000清登录态。
- 暂不提供切换模式的写入接口：写入参数还没有可验证的形状。已有一个经通用QR取得的QQ账号的只读成功样本；其他账号与宿主仍待验收，没有启用Folia模式能力。

#### 黑名单首屏与单曲风格选项

实验写入候选：`POST /user/blacklist/add`、`POST /user/blacklist/remove`。默认回 `501 feature.unavailable`；只有可信宿主配置 `QQ_UNVERIFIED_WRITES_ENABLED=1` 才能测试，正文／查询参数不能开启。开关不代表写入已完成真账号验收，也不启用下游界面能力。

- 新增正文为 `{ songs?:string[], singers?:string[], songId?:string, styles?:[{id:string,idType:number}] }`。至少选择一项；每类最多20项、合计最多30项，不接受重复项。ID为不超过40位的正十进制字符串；风格按 `id + idType` 区分，不能只按ID去重。
- 选择风格时必须给数字歌曲的 `songId`（安全整数），先读取该曲可选风格；没有候选或选项不匹配就不写。名称来自上游候选，不接收调用方伪造的名称；歌曲、歌手和风格只发送选中分类，不自动关联。风格表示「减少风格推荐」，不保证完全排除。
- 一次写入后，逐个选中分类读首屏。回 `{accepted,verified,verification,writeAttempted,coverage:"first-page",complete:false,results}`；`accepted`只表示写入回包被接受。仅所有目标在对应首屏出现时 `verified:true`、`verification:"confirmed"`；否则保持`unconfirmed`。各项结果区分`present`和`not-seen-in-first-page`，不承诺原子性或回滚，不捏造replacement。
- 取消正文为 `{type:"song"|"singer"|"style",id:string,idType:number}`，仅单类单项。先从当前账号首屏取得完整元数据再写一次；首屏没有该项回`422`且不写，表示未在支持的首屏找到，不证明全表不存在。写后即使首屏不再出现，仍为`verified:false`／`unconfirmed`，不回`removed:true`，直到完整分页另经验证。
- 写入、失败与确认读取都不自动重送。写入已尝试而结果不明时返回`writeAttempted:true`、`verified:false`、`retryable:false`；重新读取确认，不自动重写。未知业务码维持`502`，不扩大清会话的`401`。

`GET /user/blacklist?type=song|singer|style` 读取对应分类的首屏，返回 `{ code: 200, type, items, coverage: "first-page", complete: false }`。条目为 `{ id, idType, name, image, time }`；`time` 保留上游数值，不推断时间单位。风格身分由 `id + idType` 共同确定。

当前只支持首屏；`page` 只能省略或为 `1`，不接受 `cursor`。内部 `Token` 不公开。正常空首屏回 `200` 与空 `items`，仍是 `complete: false`，不能把它解释为整份清单已空。`user` 分类属于其他服务，当前不支持。

`GET /user/blacklist/style-options?songId=90001` 返回 `{ code: 200, styles: [{ id, idType, name, status }] }`。示例编号为虚构数据；`songId` 必须是正的安全整数，不是 mid。某些歌曲没有风格候选，正常返回空数组；`status` 只保留数值，不推断所有取值的意义。

两条路由需要有效会话，不匿名读取；Serverless 缺密钥回 `501`。网络、结构异常和未验证业务码回安全错误，失败不自动重试。它们不新增或取消屏蔽，也没有 Folia 黑名单管理 UI；API session、完整分页面及取消后读回仍待验收。

### 9. 批量歌曲详情

```http
POST /song/batch
```

```json
{
  "songs": [
    { "mid": "demoSongA" },
    { "mid": "demoSongB", "id": 90002 }
  ]
}
```

支持每次 1–20 首，返回逐项 `results` 和 `partial` 标记。

- 成功项返回 `song` 与 `info`。
- 失败项返回明确的错误对象。
- 部分成功时整体可以是 `200`。
- 不会将失败项静默替换成 `null`。

### 10. 评论分页

`/comment/list` 支持通用资源评论和回复：

```http
GET /comment/list?id=90001&page=0&limit=25
```

后续页面使用上一页返回的 `nextCursor`：

```http
GET /comment/list?id=90001&page=1&limit=25&cursor=...
```

`nextCursor` 必须保持原样，不要转成数字或自行拼接。

缺少游标时不能保证已经读取全部评论，也不能凭空生成下一页游标。

---

### 11. 歌曲收藏数

```text
GET /song/fav-count?ids=90001,90002,90001
```

不需要登录。`ids` 必填，用逗号分隔 1–20 个正整数 songid，不能传 MID 或超出安全整数范围的数字。同一个 id 只查询一次，响应仍按输入顺序保留重复项。

```json
{
  "code": 200,
  "items": [
    { "id": 90001, "count": 12, "display": "fixture-count" },
    { "id": 90002, "count": null, "display": null },
    { "id": 90001, "count": 12, "display": "fixture-count" }
  ]
}
```

上游未提供某首的计数或展示文字时，对应字段为 `null`；整批都没有数据回 `422`。输入超过 20 项时，即使去重后不超过 20，也回 `400`。

### 12. 用户搜索

```text
GET /search/users?keyword=fixture-user&page=1&limit=10
```

需要有效会话。`keyword` 必填，去掉首尾空格后为 1–60 个字符；`page` 为从 1 开始的正整数，默认 1；`limit` 为 1–20 的整数，默认 10。给了不合法的分页参数回 `400`。

响应为 `{ code: 200, users: [...], total: number | null }`。`users` 保留上游 `item_user` 的原始条目，`total` 取可靠的 `meta.sum`，缺失或格式不可靠时为 `null`。本页没有用户回 `422`，即使总数非零也一样。本接口不改变 `/search` 的类型和排序。

### 13. 歌曲其他版本

```text
GET /song/versions?id=90001
GET /song/versions?mid=fixtureVersionA
```

不需要登录。`id` 是正整数 songid，`mid` 是歌曲 MID，两者必须二选一；同时提供、都不提供或提供空值都回 `400`。MID 最长 64 个字母或数字。

响应为 `{ code: 200, songs: [...] }`，`songs` 保留上游 `versionList` 的原始条目；没有其他版本回 `422`。不同歌曲能返回的版本数量可能不同。

### 14. 本人音乐基因

```text
GET /user/music-gene
```

需要有效会话，没有业务参数，只读取当前登录账号。请求中的账号目标参数不会传给上游。

响应为 `{ code: 200, profile: {...} }`，`profile` 保留上游 `data` 的原始结构，包括数字类型的 `IsVisitAccount`，不转换成布尔值。成功的空对象也原样返回。上游非零业务码回 `502` 并保留 `upstreamCode`，不能仅凭数字把它解释成未登录。

四条接口在 Node 和 Serverless 使用同一套处理。两条需要会话的接口缺失、无效或过期会话回 `401`；Serverless 未配置 `QQ_SESSION_SECRET` 时先回 `501`。其余上游业务拒绝、格式异常与网络失败沿用现有的安全 `502` 分类；空清单不用 `404` 表示。

## 错误处理

新式接口使用统一错误结构：

```json
{
  "code": 429,
  "kind": "rate-limited",
  "errorKey": "upstream.rate-limited",
  "message": "Too many requests",
  "retryable": false
}
```

### 常见状态码

| HTTP 状态 | 含义 |
| --- | --- |
| `400` | 参数错误 |
| `401` | 未登录、凭证无效 |
| `405` | 写入接口用了 GET，请改用 POST |
| `422` | 上游请求成功，但没有符合要求的数据 |
| `429` | 请求过于频繁 |
| `500` | 旧接口的上游错误，或服务自身出错 |
| `501` | 当前部署缺少必要配置或能力 |
| `502` | 上游失败、网络错误或响应格式异常 |

错误响应可能包含：

- `kind`：错误类型。
- `errorKey`：稳定的错误标识。
- `retryable`：当前错误是否适合重试。
- `upstreamCode`：安全的上游数字码。
- `retryAfterMs`：建议等待时长。
- `failureHint`：可用于客户端展示的提示。

请以 `errorKey` 等结构化字段判断错误，不建议依赖英文 `message` 字符串。

完整说明见 [错误对照表](./errors.md)。

**旧曲库接口例外：** 部分旧路由仍可能使用 HTTP `200` 携带非零上游业务码，不应与新式接口混为一谈。

---

## 旧接口与升级指南

项目正在分阶段退役部分历史路由，以减少重复实现并统一后续维护范围。

### 3.3.4 已移除

以下 9 条接口已移除：

| 旧接口 | 替代接口 |
| --- | --- |
| `/getHotkey` | `/search/hot` |
| `/getSingerList` | `/singer/list` |
| `/getSingerDesc` | `/singer/detail` |
| `/getSingerStarNum` | `/singer/homepage` |
| `/getSimilarSinger` | `/singer/similar` |
| `/getSingerMv` | `/singer/mvs` |
| `/getMv` | `/mv/list` |
| `/getMvByTag` | `/mv/list` |
| `/getMvPlay` | `/mv/detail`、`/mv/url` |

替代接口可能使用不同参数、分页方式和错误响应结构，升级时需要同时检查调用逻辑。

### 3.3.5 已移除

以下 9 条接口已移除，改用对应的替代接口：

| 旧接口 | 替代接口 |
| --- | --- |
| `/getSmartbox` | `/search/match`、`/search/suggest` |
| `/getSongListCategories` | `/recommend/categories/all` |
| `/getSongLists` | `/recommend/category-playlists/sorted` |
| `/batchGetSongInfo` | `/song/batch` |
| `/getRadioLists` | `/radio/categories` |
| `/getComments` | `/comment/list` |
| `/getNewDisks` | `/recommend/new-albums` |
| `/getTopLists` | `/recommend/toplists` |
| `/getRanks` | `/recommend/toplist` |

另外 8 条没有替代接口，已直接移除：

- `/user/getCookie`
- `/user/setCookie`
- `/downloadQQMusic`
- `/getImageUrl`
- `/getRecommend`
- `/getTicketInfo`
- `/getDigitalAlbumLists`
- `/batchGetSongLists`

这 17 条在 `3.3.4` 预告过。Node 现在对它们回 `404`，Serverless 照旧回 `501`。

保留的主要曲库与 Folia 所需接口不属于上述退役清单。

完整版本规则见 [兼容性政策](./compatibility.md)。

### 迁移注意事项

- 新旧接口的参数名称可能不同。
- 页码和偏移量不能混用。
- 新接口可能采用严格参数校验。
- HTTP 状态和响应结构可能变化。
- 替代接口不保证逐字段兼容旧接口。

建议先完成新接口适配和契约测试，再移除旧调用逻辑。

---

## 项目架构与开发

### 核心架构

```text
Node / Docker / Electron / Serverless
                 │
                 ▼
           HTTP / Web 入口
                 │
                 ▼
              路由层
                 │
                 ▼
           服务与业务逻辑
                 │
        ┌────────┴────────┐
        ▼                 ▼
   协议与上游适配      会话与认证
        │                 │
        └────────┬────────┘
                 ▼
           上游音乐接口
                 │
                 ▼
             响应处理
```

### 主要目录

| 目录 | 职责 |
| --- | --- |
| `src/app.ts` | Koa 服务启动及路由挂载 |
| `src/controllers/` | HTTP 参数和响应处理 |
| `src/services/` | 音乐业务与上游数据访问 |
| `src/protocol/` | 协议结构及错误分类 |
| `src/transport/` | HTTP 等传输能力 |
| `src/serverless/` | Web 标准 Serverless 入口 |
| `tests/` | 单元、契约及发布产物测试 |

项目内部使用独立请求配置，避免改写宿主的全局 `axios.defaults`。

### 运行时导出

| 包入口 | 用途 |
| --- | --- |
| `@yakult-green-tea/qq-music-api` | Node / Electron 的 Koa 服务 |
| `@yakult-green-tea/qq-music-api/serverless` | 标准 Web 请求处理函数 |
| `@yakult-green-tea/qq-music-api/mqtt` | MQTT 协议及监听组件 |

Node 主入口载入时会启动服务，并导出 `server` 句柄。同一进程应避免重复载入。

Electron 应在主进程管理会话凭证，渲染进程不应接触 QQ 原始 Cookie 或登录凭证。

### 开发命令

| 命令 | 功能 |
| --- | --- |
| `npm start` | 从 TypeScript 源码启动 |
| `npm run build` | TypeScript 类型检查 |
| `npm run lint` | 静态检查 |
| `npm test` | Jest 测试 |
| `npm run test:contracts` | Folia、Serverless 等契约测试 |
| `npm run build:js` | 构建 CommonJS、ESM 及类型产物 |
| `npm run start:dist` | 启动编译后的服务 |

离线测试通过不代表所有 QQ 真账号、部署平台和地区环境都已经完成实际验收。

开发规范参见 [CONTRIBUTING.md](../CONTRIBUTING.md)，发布流程参见 [RELEASING.md](../RELEASING.md)。

---

## 常见问题

### 为什么 Serverless 只有微信登录？

先检查：

```http
GET /login/channels
```

可能原因：

- 未配置 `qqRelay`，因此不提供 QQ 音乐 App 的 MQTT 登录。
- 已关闭 `QQ_PTLOGIN_HTTP_ENABLED`，手机 QQ 网页登录不可用。
- 缺少必要的会话密钥。

Serverless 无中继时，默认应支持 `qq` 网页登录和 `wechat`；实际仍以能力查询结果为准。

### 扫码后一直等待确认？

请检查 `/login/qr/check` 返回的状态、`failureStage` 及相关诊断字段。

Node 微信扫码单次检查可能等待最长约 15 秒，客户端超时设置不能过短。

已扫描 `802` 不等于登录成功，只有取得会话并返回 `803` 才算完成。

### 登录提示设备已满？

QQ 可能返回登录设备名额相关错误，例如已登记的 `20279`。

可以在 QQ 音乐 App 的设备管理中清理不再使用的设备，然后重新扫码。

不要反复删除设备身份文件或频繁更换 Serverless 密钥。

### 为什么有会员仍拿不到播放链接？

播放结果不仅取决于会员等级，还可能受歌曲文件、凭证状态、网络出口及上游授权结果影响。

先确认：

1. 使用的会话是否有效。
2. 请求的音质是否有对应文件。
3. 较低音质是否可以取链。
4. 同一账号在不同网络出口是否有差异。

无法确认原因时，应显示 `url_unavailable`，不要直接判定账号不是会员或歌曲已下架。

### 为什么搜索返回空列表？

`200` 加空列表有时是确实没有搜索结果，也可能与上游对请求来源的处理有关。

建议使用同一关键词在本地 Node 和 Serverless 环境对照测试，观察响应及脱敏日志。

### 写入失败后可以直接重试吗？

不建议。

创建、删除、改名、加歌和收藏等写入有可能已经被上游执行，但确认步骤失败。

应先读取当前资源状态，确定操作是否生效，再决定下一步。

### 如何查看当前支持哪些功能？

```http
GET /login/channels
```

主要字段：

- `data.channels`：当前可用的登录通道。
- `data.sessionMode`：`stored` 或 `sealed`。
- `data.configured`：当前会话配置是否完成。
- `data.features`：后端声明的功能与方法。

`features` 表示后端已实现相应能力，不保证当前账号具备权限或上游一定返回数据。

部分尚未实现的方法会明确返回 `false`，例如 `getChorusRanges`、`getReplacement`、`reportPlayback` 及部分推荐历史/反馈能力。

---

## 安全与反馈

本项目为社区维护的非官方实现，与腾讯及 QQ 音乐没有隶属、授权或合作关系。

使用时请遵守相关平台条款及内容授权要求。

提交 Issue 时，建议提供：

- 项目版本与运行环境。
- 调用的接口及必要参数。
- 可复现步骤。
- HTTP 状态、`errorKey` 及脱敏诊断信息。

**请勿公开 Cookie、二维码标识、会话 token、设备身份文件、账号标识、完整播放链接或未脱敏的 HAR。**

欢迎通过 [GitHub Issues](https://github.com/yakult-green-tea/qq-music-api/issues) 反馈问题。

授权及来源说明：[LICENSE](../LICENSE) · [ATTRIBUTION](../ATTRIBUTION.md)
