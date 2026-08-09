# 参与贡献 (Contributing to QQ Music API)

首先，感谢您考虑为 `qq-music-api` 贡献代码！这是一个开源项目，我们欢迎并感激所有的贡献，无论是提交 Bug、改进文档还是提交新功能。

本指南将帮助您了解参与贡献的完整流程，以确保代码质量并保持项目的良好协作。

## 📑 目录

1. [行为准则](#行为准则)
2. [开发环境配置](#开发环境配置)
3. [项目目录结构](#项目目录结构)
4. [贡献流程](#贡献流程)
5. [代码提交规范](#代码提交规范)
6. [测试要求](#测试要求)
7. [代码审查流程](#代码审查流程)

---

## 行为准则

在参与本项目时，请确保尊重他人、保持友善，并以建设性的方式提出意见或代码。我们致力于提供一个无骚扰的参与体验。

安全漏洞、凭证暴露或登录态问题请遵循 [SECURITY.md](./SECURITY.md) 使用私密渠道报告。公开 Issue、PR、测试 fixture 与日志中不得包含真实 cookie、QR key、opaque session、`musickey`、auth-state 或 `.env` 内容。

## 开发环境配置

本项目基于 `Koa2` 构建，请确保您的本地环境满足以下要求：

- **Node.js**: >= 20
- **npm**
- **Git**

### 快速配置指南

```bash
# 1. 克隆项目到本地
git clone git@github.com:yakult-green-tea/qq-music-api.git
cd qq-music-api

# 2. 安装依赖
npm ci

# 3. 启动开发环境（支持热重载）
npm run dev
```

服务默认监听 `3200` 端口。您可以通过浏览器或 Postman 访问 `http://localhost:3200` 进行接口测试。

---

## 项目目录结构

在您开始贡献代码之前，了解项目的目录结构将帮助您更快地定位需要修改的文件：

```text
qq-music-api/
├── src/                  # 核心源代码目录
│   ├── app.ts            # Koa2 应用入口文件
│   ├── config/           # 项目及环境变量配置
│   ├── controllers/      # 业务控制器（处理 HTTP 请求和响应）
│   ├── middlewares/      # 自定义 Koa 中间件
│   ├── routes/           # 路由定义
│   ├── services/         # 核心业务逻辑与底层接口调用
│   └── util/             # 公共工具函数
├── tests/                # 单元测试与集成测试目录
├── docs/                 # 项目相关文档
├── public/               # 静态资源文件
├── scripts/              # 构建与辅助脚本
├── screenshot/           # 项目截图展示
├── coverage/             # 测试覆盖率报告
├── logs/                 # 本地运行日志
├── Dockerfile            # Docker 镜像构建配置
├── package.json          # 依赖管理与 NPM 脚本
└── tsconfig.json         # TypeScript 编译配置
```

---

## 贡献流程

我们采用标准的 GitHub Fork & Pull Request 工作流：

1. **Fork 本仓库** 到您的个人 GitHub 账号下。
2. **克隆您的 Fork 仓库** 到本地机器。
3. **从 `main` 创建一个新的分支** 进行开发：
   ```bash
   git checkout main
   git pull --ff-only
   git checkout -b feat/your-feature-name
   # 或者如果是修复 bug
   git checkout -b fix/your-bug-fix
   ```
4. **进行代码更改**，并在本地测试确保一切运行正常。
5. **提交代码**（必须遵循下文的[代码提交规范](#代码提交规范)）。
6. **推送到远程仓库**：
   ```bash
   git push origin feat/your-feature-name
   ```
7. **提交 Pull Request (PR)** 到本项目的 `main` 分支，并详细描述您所做的更改。

---

## 代码提交规范

我们遵循 [Angular 提交规范](https://github.com/angular/angular.js/blob/master/DEVELOPERS.md#-git-commit-guidelines)。每次提交的信息请采用如下格式：

```text
<type>(<scope>): <subject>
```

**常用的 Type 列表：**
- `feat`: 新增功能 (Feature)
- `fix`: 修复 Bug
- `docs`: 文档更新 (Documentation)
- `style`: 代码格式调整（不影响逻辑，如空格、缩进）
- `refactor`: 代码重构（既不修复 Bug 也不新增功能）
- `test`: 增加或修改测试用例
- `chore`: 构建过程或辅助工具的变动

**提交示例：**
- `feat(api): add get singer album interface`
- `fix(cookie): resolve cookie parsing error`
- `docs(readme): update quick start guide`

---

## 测试要求

本项目历史版本可能缺乏完整的单元测试覆盖。但是，对于未来的贡献，**我们强烈建议并要求为所有新功能和 Bug 修复添加对应的测试用例**。

1. **测试框架**: 推荐使用主流的 Node.js 测试工具（如 Jest 或 Mocha）。
2. **本地验证**: 在提交 PR 前，请确保完整验证链均能稳定通过：
   ```bash
   npm ci
   npm run lint
   npm run build
   npm test
   npm run build:js
   npm pack --dry-run
   ```
3. **本地 hooks**: `pre-commit` 只对暂存文件运行 `lint-staged`，`commit-msg` 只运行 `commitlint`。它们用于快速反馈，不替代 CI，也不在 `pre-push` 重跑完整构建或测试。
4. **CI 质量门**: GitHub Actions CI 是仓库的权威验证，PR 合并前必须通过 lint、类型检查、测试、JavaScript 构建和 npm package 内容检查。
5. **PR 附件**: 请在 PR 描述中说明已运行的验证。如果因为特殊原因无法完成某项检查，请在 PR 中进行说明。
6. **上游网络测试**: 不要仅凭测试是否导入 `supertest` 判断它是否访问真实 QQ 音乐服务。任何测试分层都必须使用明确的文件约定或清单，并确保巢状目录、JavaScript suite 与 coverage threshold 不会被漏掉。
7. **发布边界**: 一般 PR 不修改版本、不建立或移动 tag，也不发布 npm。发布步骤只由维护者依 [RELEASING.md](./RELEASING.md) 明确执行。

---

## 代码审查流程 (Code Review)

1. **提交审查**: 提交 PR 后，项目维护者或自动化工具会对其进行初步检查。
2. **反馈与讨论**: 维护者会对代码风格、API 设计、安全性或文档提出修改建议。
3. **修改更新**: 请根据 Review 意见在原分支上继续提交修改，PR 会自动更新。
4. **合并标准**: 所有必需的 CI 检查通过后，代码才可合并入 `main`。项目可由单一维护者维护，不强制设置会阻止维护者自行合并的多人 approval requirement。

再次感谢您对开源社区的贡献！✨
