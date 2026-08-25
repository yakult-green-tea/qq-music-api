## 未发布

暂无。

## [3.1.0](https://github.com/yakult-green-tea/qq-music-api/compare/v3.0.0...v3.1.0) (2026-08-25)

### 新功能

- 新增 `@yakult-green-tea/qq-music-api/mqtt` 子路径导出，让能够维持 WebSocket 长连接的宿主复用同一套 MQTT 编解码和 QR 事件解析逻辑。
- 为 Serverless 入口增加可注入的 QQ QR 中继；注入中继时 `/login/channels` 同时公布 QQ 与微信通道，未注入时保持仅微信通道。

### 问题修复

- MQTT WebSocket 握手失败或提前关闭时立即结束等待，避免登录请求一直挂起。
- 明确要求宿主等待 WebSocket `open` 事件后再发送 CONNECT，并正确转发 `Uint8Array` 的有效字节范围。

### 文档

- 补充 Node.js、Vercel Functions 与 Cloudflare Durable Object 的导出入口、能力边界和安全责任说明。

## [3.0.0](https://github.com/yakult-green-tea/qq-music-api/compare/v2.3.0...v3.0.0) (2026-08-18)

### 新功能

- 新增零 Koa、零 `node:*` 依赖闭包的 `./serverless` 导出和 Web 标准 `handleRequest` 入口。
- 使用密封 QR 与登录会话，使 Vercel Functions 和 Cloudflare Workers 的无状态请求能够延续扫码登录。
- 增加 Fetch 版认证与旧接口传输层，并提供登录、用户歌单、收藏专辑、我喜欢和登录态播放等必要路由。

### 问题修复

- 从密封 QR 中移除二维码图片，改为根据标识重新获取，避免令牌过大。
- 移除 Serverless 依赖闭包中的 Node.js 加密模块，解除 Edge 运行时部署阻断。

### 仓库维护

- 记录受保护分支、验证、安全报告与发布流程。
- 明确 Folia 只会在单独更新 npm 依赖与锁文件后使用新版本。
- 在包元数据和文档中保留下游贡献者署名。

## [2.3.0](https://github.com/yakult-green-tea/qq-music-api/compare/v2.2.2...v2.3.0) (2026-08-09)

### Features

- Add an injectable authentication-session repository for trusted npm hosts while retaining the in-memory default.

## [2.2.2](https://github.com/yakult-green-tea/qq-music-api/compare/v2.2.1...v2.2.2) (2026-08-09)

### Bug fixes

- Isolate the legacy QQ request client from shared `axios.defaults` so importing the package does not modify its host process.

## [2.2.1](https://github.com/yakult-green-tea/qq-music-api/compare/v2.2.0...v2.2.1) (2026-08-09)

### Bug fixes

- Publish only account identifiers that are actually available from the login credential.

## [2.2.0](https://github.com/yakult-green-tea/qq-music-api/compare/v2.1.0...v2.2.0) (2026-08-08)

### Features

- Add `GET /user/albums` for authenticated favorite-album pagination.
- Derive the account identifier required by authenticated user collections.

## [2.1.0](https://github.com/yakult-green-tea/qq-music-api/compare/v1.0.4...v2.1.0) (2026-08-07)

### Features

- Migrate the maintained fork to TypeScript and add the local API Explorer.
- Add native QQ Music App and WeChat QR login, authenticated playback, and cancellable QR sessions.
- Add runnable JavaScript package output and export the HTTP server handle for npm embedders.

### Bug fixes

- Isolate authentication requests from global Axios defaults and persist a non-secret device context.
- Correct runtime dependencies and disable the development version check for embedded consumers.

## [1.0.4](https://github.com/Rain120/qq-music-api/compare/v1.0.3...v1.0.4) (2021-01-25)


### Bug Fixes

* doc screenshot png path ([fe811e2](https://github.com/Rain120/qq-music-api/commit/fe811e26c0c0a2ed468728b0323866bd27b5a404))
* music play url quality; docs about cookie, music play; ([#35](https://github.com/Rain120/qq-music-api/issues/35)) ([f0b7923](https://github.com/Rain120/qq-music-api/commit/f0b7923b9feb7e32c44bc9417c2d426148ab3865))



## [1.0.3](https://github.com/Rain120/qq-music-api/compare/v1.0.1...v1.0.3) (2021-01-24)


### Bug Fixes

* doc screenshot png path ([cb8b253](https://github.com/Rain120/qq-music-api/commit/cb8b25358219ca1cc3e973e6f46a3f75bb3b8b29))


### Features

* user cookie ([#32](https://github.com/Rain120/qq-music-api/issues/32)) ([5a32dae](https://github.com/Rain120/qq-music-api/commit/5a32daeca351c7b18352f9267db0c173fef9bff6))



## [1.0.1](https://github.com/Rain120/qq-music-api/compare/v1.0.0...v1.0.1) (2020-12-25)


### Bug Fixes

* build docker image sh ([fe395a4](https://github.com/Rain120/qq-music-api/commit/fe395a435efc0678d3d387abbcd6b33786bb72fa))


### Features

* docker build images to hub for docker env run ([dcbbf95](https://github.com/Rain120/qq-music-api/commit/dcbbf95e70b305cd2ad4d00a7cc0bd4db5d0f8ab))
* docker repository version ([d74a425](https://github.com/Rain120/qq-music-api/commit/d74a4251da8c0c2dac2f5e4251e91f288f732d43))



# [1.0.0](https://github.com/Rain120/qq-music-api/compare/4d79041a5e5712c0c6bc6e6d55045f732636c80f...v1.0.0) (2020-09-15)


### Bug Fixes

* bug about search by key https://github.com/Rain120/qq-music-api/issues/28 ([12b7d66](https://github.com/Rain120/qq-music-api/commit/12b7d667c05f92ad61545c5f75a82d878ad3220c))
* getComment ([#26](https://github.com/Rain120/qq-music-api/issues/26)) ([9e62be5](https://github.com/Rain120/qq-music-api/commit/9e62be539b3b78cdf0eea3e1696d9505ab242756))
* getSingerHotsong pagination ([#19](https://github.com/Rain120/qq-music-api/issues/19)) ([9bb705a](https://github.com/Rain120/qq-music-api/commit/9bb705a1b6eb4e2577ba20f0a279ccb63112390d))
* getSingerHotsong pagination ([#22](https://github.com/Rain120/qq-music-api/issues/22)) ([6d6dbf3](https://github.com/Rain120/qq-music-api/commit/6d6dbf36c545269ad7a6138e711e436a90d61e28))
* issue 14 about getRank topId was invalid ([024096f](https://github.com/Rain120/qq-music-api/commit/024096fa63144391680f1d6ec376929fee697c37))
* issue 14 about getRank which bug about period change by qq music api ([f13d2b5](https://github.com/Rain120/qq-music-api/commit/f13d2b540d860994600cc2728e4d848df574b2f4))
* issue: 12 -> (getHotkey -> getHotKey); axios option error; ([ee0371b](https://github.com/Rain120/qq-music-api/commit/ee0371b32352546feb8b60b7725dc3ff66a412ef))
* issue: 12, require getHotkey Camel-Case bug ([0eb9297](https://github.com/Rain120/qq-music-api/commit/0eb9297ff19773ef2d61377f341937f20a70d6a4))
* mv params bug: https://github.com/Rain120/qq-music-api/issues/16\#issuecomment-638230301 ([8f29b87](https://github.com/Rain120/qq-music-api/commit/8f29b874705ab0638310bcc13781a5599ab9de4d)), closes [#issuecomment-638230301](https://github.com/Rain120/qq-music-api/issues/issuecomment-638230301)
* song list params bug: https://github.com/Rain120/qq-music-api/issues/16 ([d9fb973](https://github.com/Rain120/qq-music-api/commit/d9fb9732f546cb76f208053a8dabd164aad893c5))


### Features

* add song list ([c0e8de8](https://github.com/Rain120/qq-music-api/commit/c0e8de86dd93a907aa75e838c18d967b1434493d))
* batch get song info ([0ac4cfc](https://github.com/Rain120/qq-music-api/commit/0ac4cfca38e15e727d79f76c39e729a0ff3abc16))
* batch get songlist ([facc3cb](https://github.com/Rain120/qq-music-api/commit/facc3cbf7a44fbeb1db48bfa0c18e7918938b21c))
* eslint + prettier + commitlint + changelog + editorconfig ([e547ca3](https://github.com/Rain120/qq-music-api/commit/e547ca3c43db052769a06f5e0090a29749b721d5))
* get song info; rebuild the axios request, cut down route params ([4d79041](https://github.com/Rain120/qq-music-api/commit/4d79041a5e5712c0c6bc6e6d55045f732636c80f))
* getImageUrl; commit push shell; ([69f257a](https://github.com/Rain120/qq-music-api/commit/69f257a41d5d4746dce306c84ff902358a0d391c))
* rebuild router and axios ([0b737df](https://github.com/Rain120/qq-music-api/commit/0b737df8971a560119af2bcae199a1ea5549859c))
* rebuild router for lost ([2165b6a](https://github.com/Rain120/qq-music-api/commit/2165b6a8b5527bb2b68592b17e28846fce1e856f))
* rebuild routers ([1278008](https://github.com/Rain120/qq-music-api/commit/1278008d57bd8fb4bced800c3de6c6f16f0aee8f))



