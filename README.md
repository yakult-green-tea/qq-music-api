<h1 align="center">QQ Music API</h1>

<p align="center">一个可独立部署、也可嵌入 Node.js / Electron 的非官方 QQ 音乐 API。</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@yakult-green-tea/qq-music-api"><img alt="npm version" src="https://img.shields.io/npm/v/@yakult-green-tea/qq-music-api?style=flat-square"></a>
  <a href="https://github.com/yakult-green-tea/qq-music-api/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/yakult-green-tea/qq-music-api/actions/workflows/ci.yml/badge.svg?branch=main"></a>
  <a href="./LICENSE"><img alt="License" src="https://img.shields.io/github/license/yakult-green-tea/qq-music-api?style=flat-square"></a>
</p>

这个项目基于 `Koa2 + TypeScript`，通过 Web 接口访问 QQ 音乐数据。除了搜索、歌单、歌词和播放链接等常用能力，这个 fork 还加入了 QQ 音乐 App / 微信扫码登录、登录态播放、npm 嵌入和 Serverless 入口。

> [!IMPORTANT]
> 本项目由社区维护，与腾讯或 QQ 音乐不存在隶属、授权或合作关系，仅用于技术研究、学习与兼容性开发。使用者应自行遵守所在地法律、平台条款和内容授权要求。

## 这个 fork 增加了什么

- **原生扫码登录**：支持 QQ 音乐 App（MQTT over WSS）与微信两条通道。
- **更完整的登录态能力**：可读取用户信息、自建／收藏歌单、「我喜欢」歌曲和收藏专辑。
- **登录态播放**：使用扫码取得的服务端凭证请求播放链接。
- **可嵌入 npm 包**：Docker、Electron 和可信 Node.js 宿主可以直接使用编译产物。
- **可注入会话仓库**：默认只保存在进程内存；宿主可以接入自己的加密持久化实现。
- **Serverless 入口**：提供 Web 标准 `handleRequest()`，并额外导出 QQ App 扫码所需的 MQTT 能力。
- **请求隔离**：包内使用私有 Axios 实例，不会修改宿主进程的 `axios.defaults`。

上游来源、维护者与许可证保留说明见 [ATTRIBUTION.md](./ATTRIBUTION.md)。

## 快速开始

需要 Node.js 20 或更新版本。

```powershell
git clone https://github.com/yakult-green-tea/qq-music-api.git
Set-Location qq-music-api
npm install
npm start
```

服务默认监听 `http://localhost:3200`。启动后可打开 [API Explorer](http://localhost:3200/explorer) 测试接口。

常用命令：

| 命令 | 用途 |
| --- | --- |
| `npm start` | 直接运行 TypeScript 源码 |
| `npm run build` | TypeScript 类型检查 |
| `npm run lint` | Biome 代码检查 |
| `npm test` | Jest 测试 |
| `npm run build:js` | 生成 CommonJS、ESM、类型与运行时资源 |
| `npm run start:dist` | 运行编译后的服务 |
| `npm run docs` | 在本机预览 Docsify 文档 |

## 通过 npm 使用

```powershell
npm install @yakult-green-tea/qq-music-api
$env:PORT = '3200'
node node_modules/@yakult-green-tea/qq-music-api/dist/src/app.js
```

包根入口在载入时会调用 `app.listen()`，并导出 HTTP server 句柄 `server`。同一个进程内只应载入一次；嵌入方应监听 `listening` / `error`，并在退出时调用 `server.close()`。

需要跨重启保留登录态时，可在载入包后立即注入仓库：

```js
const qqMusic = require('@yakult-green-tea/qq-music-api');

qqMusic.configureAuthSessionRepository({
  kind: 'encrypted-host-store',
  load() {
    return loadAndDecryptSessions();
  },
  save(sessions) {
    encryptAndSaveSessions(sessions);
  },
});
```

`save()` 收到的是敏感登录态。宿主必须加密保存，不要写入浏览器存储、普通 JSON 文件或日志。未注入仓库时，服务重启会清除登录态。

## 扫码登录

所有登录相关接口目前都是 `GET`：

| 接口 | 说明 |
| --- | --- |
| `/login/qr/key?channel=qq\|wechat` | 创建 QR 会话并取得 `data.unikey`；未指定时使用 QQ 音乐 App |
| `/login/qr/create?key=<unikey>` | 取得上游 QR 图片 `data.qrimg` |
| `/login/qr/check?key=<unikey>` | 查询 `801` 等待、`802` 已扫描、`803` 成功或 `800` 失败／过期 |
| `/login/qr/cancel?key=<unikey>` | 关闭界面时主动取消 QR 会话 |
| `/login/status` | 查询当前登录状态 |
| `/user/detail` | 查询当前用户信息 |
| `/user/playlist` | 读取自建和收藏歌单 |
| `/user/liked-songs?offset=0&limit=100` | 分页读取内建「我喜欢」歌曲 |
| `/user/albums?offset=0&limit=20` | 分页读取收藏专辑 |
| `/getMusicPlay/:songmid?quality=flac&mediaId=<media_mid>` | 使用当前登录态取得播放链接 |
| `/logout` | 清除当前登录态 |

扫码成功后，服务会设置 HttpOnly `qqmusic_session`。跨来源 transport 可以保存 `qr/check` 响应里的完整 `qqmusic_session=<opaque token>`，再通过 `cookie` query 传回；不要记录或分享包含该参数的完整 URL。QQ 的 `musickey`、MQTT token 等原始凭证只保留在服务端。

服务同一时间只允许一个 QR 会话。新会话会接管尚未扫码的旧会话；上游要求退避时，响应会提供 `Retry-After`。

## API Explorer

Explorer 会根据 `/explorer/metadata` 动态生成接口列表和请求表单，支持方法筛选、搜索、响应预览与当前页面会话的请求日志。

1. 运行 `npm start`。
2. 打开 `http://localhost:3200/explorer`。
3. 搜索接口名称或路由，填写参数后发送请求。
4. 在右侧查看响应，并在 Logs 中检查请求历史。

![Explorer 整体预览](./docs/explorer-overview.png)

如希望启动时自动打开浏览器，可在 PowerShell 中运行：

```powershell
$env:AUTO_OPEN_EXPLORER = 'true'
npm start
```

## 运行时入口

| 导出 | 适用环境 | 用途 |
| --- | --- | --- |
| `@yakult-green-tea/qq-music-api` | Node.js、Docker、Electron | 完整 Koa 服务与可注入登录态仓库 |
| `@yakult-green-tea/qq-music-api/serverless` | Vercel Functions、Cloudflare Workers | Web 标准 `handleRequest(request, env, options)`；没有中继时仅提供微信扫码 |
| `@yakult-green-tea/qq-music-api/mqtt` | 能维持 WebSocket 长连接的可信宿主 | QQ 音乐 App 扫码所需的 MQTT 编解码与监听器 |

QQ App 扫码依赖持续的 MQTT over WSS 连接。Cloudflare 应由 Durable Object 持有连接，并向 `handleRequest` 注入 `qqRelay`；Vercel Functions 无法可靠维持这条长连接，因此只应公布微信通道。

Serverless 部署必须自行生成 `QQ_SESSION_SECRET` 并保存在平台密钥中。轮换时可以暂时提供 `QQ_SESSION_SECRET_PREVIOUS`，确认旧会话自然失效后再删除。

## 配置

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3200` | HTTP 服务监听端口 |
| `AUTO_OPEN_EXPLORER` | `false` | 启动后是否自动打开 Explorer；`npm run dev` 会设为 `true` |
| `QQ_AUTH_STATE_PATH` | `.auth-state/qq-device.json` | Android 装置标识保存位置；设为 `memory` 可关闭持久化 |
| `QQ_ENABLE_UPDATE_CHECK` | `false` | 是否在启动时检查 npm 新版本 |
| `QQ_SESSION_SECRET` | 无 | Serverless 会话加密密钥 |
| `QQ_SESSION_SECRET_PREVIOUS` | 无 | 密钥轮换期间读取旧会话的备用密钥 |

装置状态文件不包含用户凭证；多实例部署仍应分别设置 `QQ_AUTH_STATE_PATH`，不要共用同一份装置身份。

## Docker

```powershell
# 构建本地镜像
npm run build:local-images

# 运行并映射到本机 3200 端口
npm run run:images
```

仓库根目录的 `Dockerfile` 保留上游的单阶段运行方式。外部项目若通过 npm 安装本包，需要明确更新版本与 lockfile，才会使用这次发布的代码。

## 项目结构

- `src/app.ts`：Koa 入口、中间件和路由挂载。
- `src/controllers/`：HTTP 参数与响应处理。
- `src/services/`：QQ 音乐、登录和播放能力。
- `src/explorer/`、`public/explorer/`：API Explorer 的领域逻辑与界面。
- `tests/`：单元、接口、运行时与发布产物测试。
- `docs/`：完整接口与实现说明。

## 文档与发布

- [完整接口文档](./docs/README.md)
- [贡献指南](./CONTRIBUTING.md)
- [发布流程](./RELEASING.md)
- [变更记录](./CHANGELOG.md)
- [安全政策](./SECURITY.md)

提交问题时，请附上可复现步骤、Node.js 版本和经过脱敏的响应摘要。不要公开 session cookie、完整播放 URL、HAR 或其他凭证。

## 贡献者与来源

本项目是 [Rain120/qq-music-api](https://github.com/Rain120/qq-music-api) 的社区维护 fork，并以 `@yakult-green-tea/qq-music-api` 发布。感谢原作者 [Rain120](https://github.com/Rain120) 以及所有贡献者。

- [chthollyphile](https://github.com/chthollyphile)：Axios 请求隔离、可注入认证会话仓库、Serverless 集成与登录态播放改进。
- [lantudou](https://github.com/lantudou)：登录态自建歌单详情与不公开歌单读取支持。
- 完整贡献记录保留在 Git 历史与 [ATTRIBUTION.md](./ATTRIBUTION.md) 中。

欢迎提交 [Issue](https://github.com/yakult-green-tea/qq-music-api/issues) 或 [Pull Request](https://github.com/yakult-green-tea/qq-music-api/pulls)。

## License

本软件按 [MIT License](./LICENSE) 提供。
