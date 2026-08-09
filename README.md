<h1 align="center">QQ Music API</h1>

<div align="center">

<img src='music.png' />
[![npm](https://img.shields.io/npm/v/@yakult-green-tea/qq-music-api?style=flat-square)](https://www.npmjs.com/package/@yakult-green-tea/qq-music-api)
[![License](https://img.shields.io/github/license/yakult-green-tea/qq-music-api?style=flat-square)](./LICENSE)
[![GitHub last commit](https://img.shields.io/github/last-commit/yakult-green-tea/qq-music-api?style=flat-square)](https://github.com/yakult-green-tea/qq-music-api/commits/main)

[![CI](https://github.com/yakult-green-tea/qq-music-api/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/yakult-green-tea/qq-music-api/actions/workflows/ci.yml)

</div>

> QQ 音乐 API，基于 `Koa2 + TypeScript` 构建，通过 Web 端请求 QQ 音乐接口数据。
> 有问题请提 [issue](https://github.com/yakult-green-tea/qq-music-api/issues)。欢迎阅读 [参与贡献指南](./CONTRIBUTING.md)；自动化工具参与修改时请同时遵守 [仓库操作指南](./AGENTS.md)。
> 当前主干分支已完成 TypeScript 化改造，核心源码、测试与构建链路均已切换到 TypeScript 体系。
> `main` 是当前维护版本的主分支。

> ⚠️ 本项目为非官方、社区维护的 QQ 音乐 API 实现，与腾讯、QQ 音乐不存在隶属、授权或合作关系。
> 本项目主要用于技术研究、学习与兼容性开发。使用者应自行确保其使用方式符合所在地法律、平台条款以及相关内容授权要求。
> 软件本身按照 [MIT License](./LICENSE) 提供；上述说明不构成对 MIT License 已授予权利的额外限制。

### 关于本 fork

本包是 [Rain120/qq-music-api](https://github.com/Rain120/qq-music-api) 的修改版，以 `@yakult-green-tea/qq-music-api` 的名义发布到 npm，沿用原项目的 MIT 许可。上游来源、当前维护者与许可证保留说明见 [ATTRIBUTION.md](./ATTRIBUTION.md)；`LICENSE` 原文未作改动。

相对上游的差异：

- **原生扫码登录**：`/login/qr/key`、`/login/qr/create`、`/login/qr/check`、`/login/qr/cancel`，支持 QQ 音乐 App（MQTT over WSS）与微信两种扫码方式。
- **二维码会话可取消、可抢占**：关闭登录弹窗时可显式取消会话；即使取消请求没送达，尚未被扫码的旧会话也会被下一次登录接管，不会在 3 分钟 TTL 内一直返回 409。
- **可作为 npm 包内嵌**：`main` 指向编译产物 `dist/src/app.js`，Docker 镜像与 Electron 主进程都能直接 `require()`，无需 vendored 源码或额外打包步骤。
- **登录态仓库可注入**：默认仍只保存在进程内存；可信宿主可提供加密仓库，让 opaque session 在进程重启后继续映射到服务端凭证。
- **启动时的版本检查默认关闭**：被当作依赖 `require()` 时不应该在 import 期 spawn `npm`，需要时用 `QQ_ENABLE_UPDATE_CHECK=true` 显式开启。

#### 作为 npm 包使用

```sh
npm i @yakult-green-tea/qq-music-api

# 直接跑编译产物
PORT=3200 node node_modules/@yakult-green-tea/qq-music-api/dist/src/app.js
```

`require()` 该包会在 import 期直接 `app.listen()`，并导出 http server 句柄 `server`：嵌入方可以等 `listening` 事件确认端口真的绑上、挂 `error` 监听避免绑定失败变成未处理异常，退出时主动 `close()`。因为 `require` 有模块缓存，同一进程内只应该 `require()` 一次。

需要跨重启保留登录态的可信宿主，可在 `require()` 返回后立即调用 `configureAuthSessionRepository({ kind, load, save })`。`load()` 返回此前保存的 session 数组，`save(sessions)` 必须在宿主侧加密保存；不得把原始数组写进浏览器存储、普通 JSON 文件或日志。未注入时行为与旧版本一致，仍使用内存仓库。

常用环境变量：`PORT`（默认 `3200`）、`QQ_AUTH_STATE_PATH`（设备标识持久化路径）、`QQ_ENABLE_UPDATE_CHECK`、`AUTO_OPEN_EXPLORER`。

### API结构图

> 目前暂时没有时间做登录模块的接口，欢迎各位大佬给我`PR`, 阿里嘎多

![qq-music](./screenshot/qq-music.png)

### 环境要求

> 本项目采用 `Koa2 + TypeScript` 技术栈，开发与运行环境必须使用 Node.js 20 或更新版本。

```
node -v
```

### 🚀 快速入门 (Quick Start)

#### 📦 安装

请确保您的本地 Node.js 版本满足 [环境要求](#环境要求)。

```sh
git clone git@github.com:yakult-green-tea/qq-music-api.git
cd qq-music-api
npm install
```

#### 🔨 项目启动

```sh
# 开发环境（支持热重载）
npm run dev

# 类型检查
npm run build

# 代码检查
npm run lint

# 单元测试
npm run test

# 本地启动
npm start

# 编译出 JavaScript 产物（Docker / Electron 用）
npm run build:js

# 直接运行编译产物
npm run start:dist
```

项目默认监听端口是 `3200`，启动成功后可在浏览器访问 `http://localhost:3200` 体验接口服务。

`npm start` 走 `ts-node` 直接执行 TypeScript，只适合本地开发。容器与桌面端嵌入需要可 `require` 的 JavaScript：

- `npm run build:js` = `tsc -p tsconfig.build.json --outDir dist` + `scripts/prepare-runtime-assets.js`。
- 产物是 `dist/src/app.js`（入口）、`dist/package.json`（`src/app.ts` 读取的版本号）与 `dist/public/`（Explorer 静态资源，`koa-static` 从 `dist/src` 的上一级读取）。
- `dist/` 已 gitignore，每次构建前会被覆盖。
- 只在 `src/` 中真正 import 的包才能留在 `devDependencies` 之外的位置：运行时依赖必须放 `dependencies`，否则 `npm ci --omit=dev` 的镜像启动即缺包。`tests/runtime.dependencies.test.ts` 守住这条约束（`chalk`、`colors` 因此已从 `devDependencies` 移入 `dependencies`）。

### 🏗️ 项目架构

- 应用入口：`src/app.ts` 负责启动 `Koa`、注册中间件、挂载路由，并暴露 `/explorer`、`/explorer/index.html`、`/explorer/metadata`。
- 控制器层：`src/controllers/*` 负责处理 HTTP 入参、调用服务层并整理返回结果。
- 服务层：`src/services/*` 负责访问 QQ 音乐相关能力，是歌曲、歌手、歌单、排行榜等数据获取逻辑的核心承载层。
- Explorer 元数据层：`src/config/apiExplorer.ts` 维护接口清单、请求方法、分类、参数与 `POST` 请求体示例，驱动调试表单动态渲染。
- Explorer 逻辑层：`src/explorer/contracts`、`src/explorer/domain`、`src/explorer/application` 负责状态模型、树构建、搜索筛选和 Store/Command 逻辑。
- Explorer 视图层：`public/explorer/*` 提供静态页面、交互脚本和样式，组成完整的本地调试工作台。
- 测试与文档：`tests/*` 覆盖控制器、服务和 Explorer，`docs/*` 用于 Docsify 文档与界面截图展示。

#### 🔎 API Explorer

- `API Explorer` 是项目内置的本地接口调试工作台，用于快速选择接口、填写参数、发送请求并查看结果。
- 默认入口地址是 `http://localhost:3200/explorer`，访问 `/explorer` 时会自动重定向到 `/explorer/index.html`。
- Explorer 元数据接口为 `http://localhost:3200/explorer/metadata`，页面会基于该接口动态生成可调试的接口列表与表单。

#### Explorer 启动方式

```sh
# 开发模式：默认自动打开 Explorer
npm run dev

# 本地启动服务后手动打开 Explorer
npm start

# 启动时显式开启自动打开
AUTO_OPEN_EXPLORER=true npm start

# 禁用自动打开（dev 脚本默认会开启）
AUTO_OPEN_EXPLORER=false npm run dev
```

- `npm run dev` 默认会设置 `AUTO_OPEN_EXPLORER=true`，因此服务启动后会自动拉起浏览器。
- `npm start` 默认只启动服务，不会自动打开页面，可手动访问 `http://localhost:3200/explorer`。
- 在 `CI` 或测试环境下不会自动打开浏览器。

#### Explorer 操作步骤

1. 启动服务并打开 `http://localhost:3200/explorer`。
2. 在顶部选择请求方法：`ALL`、`GET` 或 `POST`。
3. 在搜索框中输入接口名、路由关键字或分类关键字，选择目标接口。
4. 根据表单提示填写路径参数、查询参数，或为 `POST` 接口编辑 JSON Body。
5. 点击 `发送请求`，在右侧查看最新响应结果。
6. 在 `Logs` 区域检索当前会话中的历史请求、失败记录和最近一次请求。

#### Explorer 界面能力

- **接口筛选**：支持按请求方法过滤，并通过搜索框快速定位接口。
- **动态表单**：根据接口元数据自动生成路径参数、查询参数和请求体输入区域。
- **响应预览**：展示最近一次请求的状态、耗时和格式化后的返回内容。
- **会话日志**：保存当前页面会话内的请求记录，支持按关键字搜索以及按 `全部`、`仅失败`、`仅进行中`、`仅成功` 过滤。
- **快速跳转**：内置 `最近请求` 和 `最近失败` 快捷按钮，便于定位调试问题。

#### Explorer 功能截图

**整体预览**

![Explorer 整体预览](./docs/explorer-overview.png)

#### Explorer 使用示例

以搜索歌曲接口为例：

1. 启动项目后进入 `http://localhost:3200/explorer`。
2. 选择或搜索 `getSearchByKey`。
3. 在参数区填写 `key=周杰伦`，可按需补充 `limit`、`page` 等参数。
4. 点击 `发送请求`。
5. 在 `Response` 面板查看接口返回，在 `Logs` 面板查看本次请求的 URL、状态和结果摘要。

> 提示：部分 `POST` 接口会提供默认 JSON Body 示例，可直接修改后发起请求，适合调试批量查询类接口。

### 🧱 当前技术栈与状态

- 服务框架：`Koa2`
- 语言体系：`TypeScript`
- 请求能力：`Axios`
- 代码检查：`Biome`
- 测试方案：`Jest + Supertest`
- 构建与容器：支持本地运行与 Docker 镜像构建

### ⏭️ Next 更新计划

- 持续补齐接口层、服务层与工具层测试用例，进一步提升覆盖率与回归稳定性。
- 完善 TypeScript 类型建模，收敛控制器、服务返回结构与公共工具的类型边界。
- 优化 Docker 与生产部署链路，确保构建产物、运行方式和发布流程保持一致。
- 持续更新接口文档、贡献指南和仓库自动化说明，减少文档与实现之间的偏差。
- 逐步推进登录态、个性化数据等高复杂度接口能力的调研与实现。

### 🐳 Docker

```sh
# local local build
npm run build:local-images

# local remote build
npm run build:remote-images

# build images
npm run build:images

# local run
npm run run:images

# remote run
docker pull qq-music-api
```

仓库根目录的 `Dockerfile` 是上游原有的单阶段镜像（`ts-node` 直跑源码）。Folia 的 `folia-qq-api` 镜像由 Folia 仓库独立维护，通过 npm 安装固定版本的 `@yakult-green-tea/qq-music-api`，再以非 root 用户运行 `dist/src/app.js`；它不复制本仓库源码。这里的改动只有在发布新版本、并由 Folia 明确更新依赖与 lockfile 后才会进入 Folia。

### 功能特性

- [x] 获取歌曲播放链接 **2021-01-24**
- [x] 支持自定义设置 `cookie` **2021-01-23**
- [x] 获取歌曲 + 专辑图片 **2020-05-24**
- [x] 获取歌手热门歌曲 **2020-07-04**
- [x] 获取QQ音乐产品的下载地址
- [x] 获取歌单分类
- [x] 获取歌单列表
- [x] 获取歌单详情
- [x] 获取MV标签
- [x] 获取MV播放信息
- [x] 获取歌手MV
- [x] 获取相似歌手
- [x] 获取歌手信息
- [x] 获取歌手被关注数量信息
- [x] 获取电台列表
- [x] 获取专辑
- [x] 获取数字专辑
- [x] 获取歌曲歌词
- [x] 获取MV
- [x] 获取新碟信息
- [x] 获取歌手专辑
- [x] ~~获取歌曲VKey~~ **2021-01-24**
- [x] 获取搜索热词
- [x] 获取关键字搜索提示
- [x] 获取搜索结果
- [x] 获取首页推荐
- [x] 获取排行榜单列表
- [x] 获取排行榜单详情
- [x] 获取评论信息(cmd代表的意思没太弄明白)
- [x] 获取票务信息
- [x] 获取歌单详情
- [x] 获取歌手列表
- [x] QQ 音乐原生扫码登录、登录状态和用户歌单 **2026-08-04**
- [x] 扫码登录态歌曲播放链接 **2026-08-05**
- [x] 微信扫码后的自建／收藏歌单与内建「我喜欢」歌曲 **2026-08-06**

### QQ 音乐原生扫码登录

服务提供与网易云接口形状兼容的扫码流程：

1. `GET /login/qr/key?channel=mobile|wechat` 取得 `data.unikey`；未指定时仍走 QQ 音乐 App 通道。
2. `GET /login/qr/create?key=<unikey>` 取得 `data.qrimg`（App 通道为 PNG，微信通道依上游实际图片型别返回，目前为 JPEG）。
3. 轮询 `GET /login/qr/check?key=<unikey>`；状态码为 `801` 等待、`802` 已扫码、`803` 成功、`800` 过期或失败。
4. 成功后调用 `GET /login/status`、`GET /user/detail`、`GET /user/playlist`；内建「我喜欢」歌曲以 `GET /user/liked-songs?offset=0&limit=100` 分页读取，收藏的专辑以 `GET /user/albums?offset=0&limit=20` 分页读取。
5. `GET /getMusicPlay/:songmid?quality=flac` 会在 opaque session 有效时使用该登录态取得播放链接；`GET /logout` 清除登录态。

凭证只存在服务端；默认仓库是短期内存，可信嵌入方也可注入加密仓库。`qr/check` 返回和设置的 cookie 是随机 opaque session ID，不包含 QQ 的 `musickey` 或 `musicid`。服务限制同一时间只有一个 QR，并在失败后通过 `Retry-After` 提示退避。Node.js 20+ 的 MQTT WebSocket 由最小 `ws` runtime dependency 提供，不需要二维码生成套件。

同源浏览器会自动携带 HttpOnly session；跨来源 Folia transport 使用 `qr/check` 返回的完整 `qqmusic_session=<opaque token>` 作为 `cookie` query。不要记录或分享该 query 的完整 URL。播放请求仍通过 auth 专用的 `createAuthHttpClient` 发出，不依赖全局 axios defaults。

`/user/playlist` 会合并 `GetPlaylistByUin` 的自建项目与 `CgiGetPlaylistFavInfo` 的收藏歌单并去重；两者使用的账号标识不同。内建 `dirId: 201` 不是普通 `disstid`，其歌曲必须由 `/user/liked-songs` 使用登录凭证的 `encryptUin` 查询，不能交给通用歌单详情端点。

`/user/albums` 是唯一不走 `musicu.fcg` 的用户集合。2026-08-08 对一个已收藏两张专辑的真实登录态实测：`music.musicasset.AlbumFavRead/CgiGetAlbumFavInfo` 确实存在，但在 13 种入参（含 `{}`）与 4 种客户端标识下一律返回 `80000` 与全零结构，所以该码并不是「没有数据」；同族其余方法也都不应答（`CgiGetAlbumFavList` 为 `40000`，`music.musicasset.SingerFavRead` 为 `500003`）。改用 `fav/fcgi-bin/fcg_get_profile_order_asset.fcg`，它接受原生扫码凭证：同一支接口以 `reqtype=3` 返回的收藏歌单与 musicu 完全一致，不带 cookie 则降为 `4000`。其分页参数 `sin`／`ein` 是闭区间下标，不是偏移量加数量。

歌曲详情中的 `file.media_mid` 可能不同于 `songmid`；调用播放接口时应把它传为 `mediaId`，用于构造 QQ vkey filename。2026-08-05 的 G4 实测中，部分歌曲在 320／128 请求均返回 HTTP 200、global code 0、module code 0，但 `purl` 仍为空；该响应没有提供会员、地区或版权原因，不能由服务端把空 URL 命名为「下架」或断定单一根因。可播放歌曲、QQ 搜索及自动 QRC 歌词均已通过人工验收。

2026-08-04 已完成一次正式 service 的真实扫码验收：`801 waiting → 802 scanned → credential exchange → 803 confirmed`，随后 `GetLoginUserInfo` 返回 HTTP 200 / code 0。实测 QIMEI 外层 `data` 仍是 JSON 字符串，解析后 `q16` / `q36` 均存在；同日修复了 `GetSession.data.session.uid` 可能为数字而不是字符串的兼容问题。

2026-08-05 的 G3 复验中，正式 service 重启后收到 HTTP 200、outer code `-30002`、outer data `undefined`，而同环境的独立 probe（稳定装置与 fresh device 皆然）都能取得 outer／inner code 0 和长度 36 的 q16／q36。**根因已定位并修复**：`src/util/request.ts` 当时在 import 阶段改写全局 `axios.defaults`（POST `Content-Type` 改成 `application/x-www-form-urlencoded;charset=UTF-8;text/plain;`），而 `axios.create()` 会在调用当下快照这些默认值。在 Koa server 内，import 顺序决定 auth client 是在该模块之前还是之后建立；之后建立时 QIMEI 的 JSON body 就被标成 form-urlencoded，上游随即返回 `-30002` 且没有 `data`。独立 probe 从不 import 该模块，所以一直成功。这也解释了为什么重启无效、以及为什么 2026-08-04 能通过而次日不能。

最初的修复落在 auth 一侧：`services/auth/httpClient.ts` 每次请求都自行钉住 `Content-Type: application/json`（仅在带 body 时）与 `responseType: 'json'`，避免继承宿主默认值。针对 npm 包嵌入 Electron 或 Node 宿主的场景，`src/util/request.ts` 现在也使用包私有 Axios 实例保存旧版 QQ 请求默认值；导入本包不再改写宿主共享的 `axios.defaults`。`-30002` 仍然只作为安全数字码保留，不赋予官方错误名称。

同时新增 `services/auth/deviceContext.ts`：可注入、可测试且可配置存储位置的 Android device context repository。默认写入 `.auth-state/qq-device.json`（权限 0600，已 gitignore），可用 `QQ_AUTH_STATE_PATH` 指定其他路径，或设为 `memory` 关闭持久化；写盘失败会降级为进程内上下文而不阻断登录。QIMEI 与 device session 因此可以跨进程重启复用，不必每次启动都重新注册装置。存储内容只有装置识别值，**不包含 `musickey`、MQTT token 或任何用户凭证**；多实例部署请各自指定 `QQ_AUTH_STATE_PATH`，不要共用同一份装置身份。

建立 QR session 之前的失败（QIMEI 或 GetSession）会套用指数退避：首次返回 502 + `Retry-After` 并附安全数字码 `upstreamCode`，随后的请求返回 429，避免用户连点打出连续 500 或连续冲击上游。未注入 auth session repository 时，服务重启仍会清除全部 QR 与登录 session；注入仓库时只恢复尚未超过 24 小时 TTL、且通过完整结构校验的登录 session。

### 使用文档

通用上游 API 可参考 [Rain120/qq-music-api 文档](https://rain120.github.io/qq-music-api/#/)；本 fork 新增的 npm 嵌入、扫码登录与登录态接口以本 README 为准。

### 上游 Star History

以下图表记录原项目 `Rain120/qq-music-api` 的历史，不代表当前 fork 的发布或维护状态。

<a href="https://www.star-history.com/?repos=rain120%2Fqq-music-api&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/image?repos=rain120/qq-music-api&type=date&theme=dark&logscale&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/image?repos=rain120/qq-music-api&type=date&logscale&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/image?repos=rain120/qq-music-api&type=date&logscale&legend=top-left" />
 </picture>
</a>

### 关于项目

**灵感来自**

[Binaryify/NeteaseCloudMusicApi](https://github.com/Binaryify/NeteaseCloudMusicApi)

[Vue2.0开发企业级移动端音乐Web App](https://coding.imooc.com/class/107.html)

**参考内容**

[Koa 2](https://koa.bootcss.com/)

[Axios](https://github.com/axios/axios)

[阮一峰老师 - HTTP Referer 教程](http://www.ruanyifeng.com/blog/2019/06/http-referer.html)

### 项目不足

1. 当前已补充基础 `unit test` 与接口测试，但整体覆盖率和复杂场景用例仍有继续提升空间。
2. 独立服务默认使用进程内登录态；需要跨重启或多实例共享时，部署方必须自行提供受保护的 `AuthSessionRepository`。仓库的加密、并发一致性与密钥管理属于宿主责任。

### 自动化工具说明

本项目没有独立的 AI agent runtime。`AGENTS.md` 仅用于约束 coding agent 与自动化工具在仓库中的修改范围；项目运行时架构仍是标准的 `controller → service → util` 链路。

#### 🤝 参与贡献 ![PR](https://img.shields.io/badge/PRs-Welcome-orange?style=flat-square&logo=appveyor)

我们非常欢迎并感激所有的贡献！无论是提交 Bug、改进文档还是新增功能，您的支持对项目发展至关重要。

详细的贡献流程、代码提交规范以及本地开发配置，请仔细阅读我们的 **[参与贡献指南 (CONTRIBUTING.md)](./CONTRIBUTING.md)**。您可以通过提交 [Pull Requests](https://github.com/yakult-green-tea/qq-music-api/pulls) 或发布 [Issue](https://github.com/yakult-green-tea/qq-music-api/issues) 来参与共建。

#### 👨‍🏭 作者

> Front-End development engineer, technology stack: React + Typescript + Mobx, also used Vue + Vuex for a while

- [Github](https://github.com/Rain120)
- [知乎](https://www.zhihu.com/people/yan-yang-nian-hua-120/activities)
- [掘金](https://juejin.im/user/57c616496be3ff00584f54db)

#### 📝 License

本软件按仓库中的 [MIT License](./LICENSE) 提供。原项目、当前维护者与贡献历史说明见 [ATTRIBUTION.md](./ATTRIBUTION.md)。
