# 相容与版本政策

接入本项目时，请优先使用公开 HTTP 接口和 npm 导出。升级前阅读 [CHANGELOG](../CHANGELOG.md)，确认正在使用的路由是否有变动；参数和响应示例见[使用文档](./README.md)。

## 哪些接口保持稳定

以下内容属于公开接口。重构内部实现时，会保留它们的调用方式和可观察行为：

| 接口 | 稳定范围 |
| --- | --- |
| HTTP 路由 | 已公布的路由路径、HTTP 方法、参数、响应字段及状态语义；明确预告退役的路由按下文流程处理 |
| 错误正文 | `code`、`kind`、`errorKey`、`upstreamCode` 的字段名与已有含义；可选字段没有值时可以省略 |
| `./serverless` | `handleRequest(request, env, options)` 的签名、默认导出，以及公开的环境配置和中继类型 |
| `./mqtt` | `createMqttListenOver` 及公开的连接、套接字和 QR 事件类型 |
| 根模块 | `server`、`configureAuthSessionRepository`、`default`（Koa 应用）；加载根模块即启动监听的行为保留 |
| `./package.json` | 供嵌入方定位包根目录的入口 |

HTTP 状态也是接口的一部分：`401` 表示未登录或已确认的凭证拒绝，不能因为普通上游错误就清除会话；`429` 按返回的冷却信息处理；新路由不会用 `404` 表示没有数据。旧曲库接口可能以 HTTP `200` 加正文中的上游码表示拒绝，不能只检查 HTTP 状态。完整规则见[错误对照表](./errors.md)。

客户端应忽略不认识的可选字段。`/login/channels` 的能力声明说明后端实现了什么，不代表当前账号一定有权限，也不保证 QQ 每次都会返回数据。上游可能改变内容、授权结果或响应格式，这些变化不由本项目控制。

## 为嵌入方保留的内部路径

以下路径有已知下游（例如 Folia）在使用，所以会保留原位置，不会在内部重构时移动：

- `dist/src/services/auth/qrLogin.node.js`：保留 `qrLoginService`，以及 `failSession(session, error, stage)`、`failBootstrap(error, stage)` 的现有调用方式。
- `dist/src/util/logger.js`：保留同一个 `logger` 对象，以及现有 `qq-auth.*` 事件名和字段。

这些是嵌入兼容路径，不作为通用 SDK 另行保证；保留现有接点，不代表所在模块的所有内部实现都是公开接口。新集成优先使用公开导出。`dist/src/app.js` 作为现有 Node 启动入口也会保留。

设备身份、设备文件和加密会话的已有格式会保持向后兼容，避免升级让用户被视为新设备或无故退出登录。

## 版本规则

按 SemVer，版本号应这样区分：

| 改动 | 版本 |
| --- | --- |
| 移除公开路由，或以不兼容的方式修改参数、字段、状态语义 | major |
| 新增路由、可选参数或可选字段，且保留已有行为 | minor |
| 在已有契约内修复 bug，或更新文档 | patch |

**当前 `3.3.x` 系列沿用已有发布安排，没有严格按上述 SemVer 规则划分版本。** 其中 `3.3.4` 移除了 `3.3.3` 已预告的 9 条旧路由，`3.3.5` 移除了 `3.3.4` 已预告的 17 条，这些都是对这些路由调用方的破坏性变更。不要仅凭 patch 版本号判断升级没有影响，也不要把这次安排当作其他接口可以直接移除的许可。每条路由至少提前一个发布版本预告退役，并提供替代方案。

## 路由怎么退役

1. 在使用文档和 CHANGELOG 中标明待退役路由、替代接口和计划移除的版本。
2. 至少保留一个已发布版本供调用方迁移；参数、响应或分页方式不同的地方需要写清楚。
3. 移除时同步接口文档、API Explorer 和契约测试，确认已知下游不再依赖该路由。
4. 在使用文档的“已移除”一节保留迁移对照，方便旧链接的读者找到接手接口。

`3.3.4` 移除的 9 条路由及替代接口见[已移除](./README.md#334-已移除)。

## 3.3.5 移除的旧路由

以下 17 条 Node 旧路由在 `3.3.5` 移除，`3.3.4` 预告过。对仍在使用这些路由的调用方，这是破坏性变更，不能仅凭 patch 版本号判断升级没有影响。有替代接口的按下表迁移，并调整参数、响应和分页；没有替代接口的已直接移除。

| 已移除的旧路由 | 改用 |
| --- | --- |
| `/getSmartbox` | `/search/match`、`/search/suggest` |
| `/getSongListCategories` | `/recommend/categories/all` |
| `/getSongLists` | `/recommend/category-playlists/sorted` |
| `/batchGetSongInfo` | `POST /song/batch` |
| `/getRadioLists` | `/radio/categories` |
| `/getComments` | `/comment/list` |
| `/getNewDisks` | `/recommend/new-albums` |
| `/getTopLists` | `/recommend/toplists` |
| `/getRanks` | `/recommend/toplist` |

以下 8 条没有替代接口，已直接移除：

- `/user/getCookie`
- `/user/setCookie`
- `/downloadQQMusic`
- `/getImageUrl`
- `/getRecommend`
- `/getTicketInfo`
- `/getDigitalAlbumLists`
- `/batchGetSongLists`

保留接口的契约不因内部整理而改变，Folia 这类使用保留接口的下游不用修改接入代码。迁移细节见[使用文档](./README.md#335-已移除)。

## 3.3.7 播放结果的两处变化

`/getMusicPlay` 带会话时，有两种上游回得不正常的情况，结果和以前不同。这是为了避免调用方拿到别首歌的链接而做的修正，属于已有契约之外的例外：

| 情况 | 3.3.6 及以前 | 3.3.7 起 |
| --- | --- | --- |
| 上游回了没请求过的歌 | 照样放进 `data.playUrl` | 不放进结果，只在日志里记数量 |
| 上游漏掉了请求的歌 | 那首直接缺席 | 补一条空链接，提示是原因尚未确认（试听时是试听暂时不可用） |

正常回应不受影响，也不会因此多发请求。如果你的客户端找不到请求的那首时会改用结果里的第一条，升级后会读到那首的空链接，不会再读到别首歌。建议直接按请求的 mid 读结果。

## 下游怎么升级

精确锁版的应用需要同时更新 `package.json` 和对应 lockfile，并重新构建。只发布本包，不会让已安装的应用自动获得修复。

| 使用方式 | 升级步骤 |
| --- | --- |
| 独立 Node 服务 | 更新依赖和锁文件，安装新版本并重启服务 |
| Electron 内嵌 | 更新依赖和锁文件，重新打包并发布应用；终端用户更新应用后生效 |
| Docker | 更新构建所用的依赖和锁文件，重建镜像并重建容器，复用原有状态卷和密钥 |
| Vercel | 更新依赖和锁文件，重新构建并部署 |
| Cloudflare Workers | 更新依赖和锁文件，重新打包并部署；使用中继时检查对应绑定与部署 |

Folia 是已知下游。它的应用根目录和 `deploy/docker/qq-api/` 分别有依赖与锁文件，升级时两组都要同步；Vercel、Cloudflare 也需要重新部署。外接独立 API 时，由服务部署者升级 API。

升级前请保存好自己的状态卷和密钥。验证时检查实际运行的包版本、登录通道及关键读写功能，不要只凭安装成功判断升级完成。
