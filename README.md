<h1 align="center">QQ Music API</h1>

<img width="1672" height="941" alt="QQ Music API 功能全景图" src="https://github.com/user-attachments/assets/8bb7f377-4c95-4fea-8b76-0653add1997f" />

[![npm version](https://img.shields.io/npm/v/@yakult-green-tea/qq-music-api?style=flat-square)](https://www.npmjs.com/package/@yakult-green-tea/qq-music-api)
[![npm downloads](https://img.shields.io/npm/dt/@yakult-green-tea/qq-music-api?style=flat-square)](https://www.npmjs.com/package/@yakult-green-tea/qq-music-api)
[![CI](https://github.com/yakult-green-tea/qq-music-api/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/yakult-green-tea/qq-music-api/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/yakult-green-tea/qq-music-api?style=flat-square)](./LICENSE)


## 项目简介

一个基于 `Koa2 + TypeScript` 构建的非官方 QQ 音乐 API，提供 QQ 音乐数据访问、扫码登录、个人音乐库管理、歌曲播放链接及推荐等功能

支持 Node.js、Docker、Electron 独立部署或嵌入式集成，同时兼容 Vercel、Cloudflare Workers 等 Serverless 运行环境

原作者项目: https://github.com/Rain120/qq-music-api

本项目在原项目基础上，完善了接口功能、多通道扫码登录、会话管理、错误处理及跨平台部署能力

> [!IMPORTANT]
>
> ## 注意
>
> 本项目与腾讯或 QQ 音乐没有隶属、授权或合作关系。使用时请遵守平台条款和内容授权要求
>
> 当前代码仅供学习，不可做商业用途


## 快速开始

需要 **Node.js 20 或更新版本**和 npm。安装后直接启动：

```sh
npm install @yakult-green-tea/qq-music-api
node node_modules/@yakult-green-tea/qq-music-api/dist/src/app.js
```

默认端口是 `3200`，可以通过 `PORT` 修改。启动后打开 [API Explorer](http://localhost:3200/explorer)，就能查看参数并试用公开接口

从源码运行：

```sh
git clone https://github.com/yakult-green-tea/qq-music-api.git
cd qq-music-api
npm ci
npm start
```

需要固定版本时，请使用对应的 release tag；`main` 可能包含尚未发布的改动

### Docker

在仓库根目录运行以下命令。需要跨重启保存登录时，先设置自己的 `QQ_SESSION_SECRET`：

```sh
npm run build:local-images
npm run run:images
```

镜像使用 Node.js 24，只安装生产依赖，默认映射本机 `3200` 端口。运行脚本会挂载 `qq-music-api-state` 卷；重建时复用同一个卷和密钥，才能保留设备身份与加密会话。没有密钥时会话只存内存，重启后需要重新登录。详见[部署与配置](./docs/README.md#docker-部署)

### Electron 与 Serverless

Electron 在主进程加载根模块即可启动服务，导出的 `server` 用于监听启动结果和关闭服务。宿主可以通过 `configureAuthSessionRepository` 注入加密会话仓库，入口说明见[运行时导出](./docs/README.md#运行时导出)。

Vercel、Cloudflare Workers 等宿主使用 `@yakult-green-tea/qq-music-api/serverless` 的 `handleRequest(request, env, options)`，并由平台传入 `QQ_SESSION_SECRET`。这是可嵌入的请求处理函数，部署入口、跨来源 CORS 和预检由宿主负责。详见 [Serverless 接入](./docs/README.md#serverless-接入)。

## 登录通道与宿主差异

通道由 `channel` 参数选择；请用对应的 App 扫码

| 通道 | 扫码方式 | Node.js / Docker / Electron | Serverless，无中继 | Serverless，有中继 |
| --- | --- | --- | --- | --- |
| `qq` | 手机 QQ 扫码 | MQTT 长连接 | 默认使用 ptlogin HTTP 网页登录，可关闭 | MQTT 中继 |
| `wechat` | 微信扫码 | 支持 | 支持 | 支持 |
| `qqmusic` | QQ 音乐 App 扫码 | MQTT 长连接 | 不提供 | MQTT 中继 |

QQ 音乐 App 扫码使用 App 当前登录的账号。Serverless 的中继由宿主提供，例如 Cloudflare Durable Object，本包不附带中继服务。没有中继时，设置 `QQ_PTLOGIN_HTTP_ENABLED=0` 可关闭手机 QQ 网页登录。可用通道以 `/login/channels` 的 `data.channels` 为准

Node 使用 `stored` 会话，默认保存在内存，可配置加密持久化，并在凭证快到期、有请求时自动续期。Serverless 使用 `sealed` 会话，客户端需要在到期前调用 `POST /login/refresh` 并保存新 token，从首次扫码起最多续到 30 天。完整流程见[扫码登录](./docs/README.md#扫码登录与会话管理)

部署前还要留意：

- **Serverless 的搜索与播放可能受限**：实测过同一账号在本地能播放，网页版却有几首拿不到链接；搜索也可能返回成功但结果为空。原因尚未完全确认，不能保证换部署就能解决
- **设备数有上限**：新的设备身份可能触发 `20279`。先在 QQ 音乐 App 的设备管理中移除不再使用的设备，再重新扫码；请妥善保留设备文件和会话密钥
- **Serverless 登出有边界**：客户端清除 token 后退出登录，已签发的 sealed token 不会立即被服务端撤销

## 文档、版本与集成

- [使用文档](./docs/README.md)：部署配置、登录流程、接口参数和响应示例
- [错误对照表](./docs/errors.md)：HTTP 状态、`kind`、`errorKey`、上游数字码和重试规则
- [相容与版本政策](./docs/compatibility.md)：稳定接口、保留路径、版本规则、退役流程与升级方式
- [架构说明](./ARCHITECTURE.md)：代码分层、两种宿主的请求流程、路由清单、打包规则与行为比对工具
- [变更记录](./CHANGELOG.md)、[npm 包](https://www.npmjs.com/package/@yakult-green-tea/qq-music-api)和 [GitHub Releases](https://github.com/yakult-green-tea/qq-music-api/releases)：查看改动并获取发布版本


## 致谢

原作者: https://github.com/Rain120/qq-music-api 为本项目基础

- 感谢 [chthollyphile](https://github.com/chthollyphile) 在请求隔离、会话仓库、Serverless 集成、登录态播放和 QIMEI 时钟偏差恢复方面的贡献
- 感谢 [lantudou](https://github.com/lantudou) 对登录态自建歌单详情和不公开歌单读取的支持
- 完整说明见 [ATTRIBUTION.md](./ATTRIBUTION.md) 与 Git 历史

### 依赖此项目的优秀开源项目

- [chthollyphile/folia-major](https://github.com/chthollyphile/folia-major)


## 授权

本项目采用 [MIT License](./LICENSE)，保留原作者 Rain120 的来源记录与原始许可证

作者的请求：希望大家不要把本项目用于商业用途。这只是请求，不改变 MIT License 给你的任何权利，上游原始许可证也照旧
