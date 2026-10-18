# Pi Station

Pi Station 是 [pi 编程智能体](https://github.com/earendil-works/pi)的插件包，提供本地 Web 和 macOS 桌面客户端。安装后在 pi 中通过 `/station` 打开界面。对话直接调用你已经安装在 `PATH` 中的 `pi`，共用 pi 的配置、登录凭据、扩展和会话文件。

```text
浏览器 / Pi Station.app
        │ HTTP + SSE
Pi Station 本地服务（127.0.0.1:30141）
        │ JSONL RPC
PATH 中的 pi --mode rpc
        │
~/.pi/agent
```

Pi Station 独立于 pi 源码仓库，不需要 `../pi` 或 `sync-pi`。使用时只需启动 Pi Station，需要运行会话时它会自动创建 pi 子进程，无须再手动开启一个 pi 终端。

## 功能

- **会话管理**：按项目浏览、继续、重命名、置顶、归档、导出和删除对话，查看运行状态、上下文和用量。
- **会话分支**：从已有消息创建独立会话，或在当前会话内切换分支。
- **项目文件**：浏览和上传文件，查看 Git Diff，预览源码、Markdown、图片、音频、PDF 和 DOCX。
- **Git worktree**：切换项目工作目录，将同一仓库不同 worktree 的会话归组显示。
- **模型与资源设置**：管理模型、Provider 登录、API Key、插件包、技能和 MCP 配置。
- **Web 与桌面共用服务**：浏览器和 Electron 窗口可以同时连接同一个本地服务。
- **界面**：支持英文、简体中文、繁体中文，以及跟随系统切换的 Clay 浅色和深色主题。

## 环境要求

- **Node.js 22.19.0 或更新版本**：运行 Pi Station 的 Web 后台。
- **npm**：安装依赖、执行仓库中的启动和构建脚本。
- **独立安装的 pi CLI**：启动 Pi Station 的环境中必须能找到 `pi`。
- **macOS**：使用当前桌面客户端和 `.app` 打包脚本时需要。

先在终端确认：

```bash
node --version
npm --version
pi --version
```

如果已经在 pi 中配置过模型和登录凭据，Pi Station 会沿用它们。默认数据目录为 `~/.pi/agent`；`PI_CODING_AGENT_DIR` 可以指定其他 pi 数据目录。

## 作为 pi 插件安装

```bash
pi install git:github.com/justinchoi929/pi-station
```

安装后重启 pi，或在已有 pi 会话里执行 `/reload`，然后使用：

| pi 命令 | 功能 |
| --- | --- |
| `/station` 或 `/station web` | 启动本地服务并打开浏览器。 |
| `/station desktop` | 启动本地服务并打开 macOS 桌面窗口。 |
| `/station status` | 在对话区输出 CLI、Web、桌面状态和日志路径。 |
| `/station stop` | 关闭插件启动的桌面进程及后台服务。 |

在 pi 终端中输入 `/station `（末尾加空格），用上下键选择操作，按回车直接执行；Tab 只补全命令。

首次启动会自动安装 Web 运行依赖并构建界面，可能需要几分钟；后续启动复用已准备好的运行环境。首次打开桌面端时才会安装 Electron。用户不需要手动克隆仓库、运行 npm 或构建项目，但环境中仍需可用的 Node.js、npm 和 pi。

插件及其后台服务使用同一个 `PI_CODING_AGENT_DIR`。构建产物和依赖保存在该目录的 `pi-station/` 下，默认是 `~/.pi/agent/pi-station/`，不会写入源码仓库的 `.next/`。源码更新后会使用新的运行环境缓存。

服务默认监听 `127.0.0.1:30141`。如该端口已有 Pi Station 服务，会直接复用；`/station stop` 会保留这类独立启动的服务。关闭 pi 终端、浏览器或桌面窗口后，插件后台可以继续运行；需要结束时执行 `/station stop`。通过插件打开桌面端后，`⌘Q` 退出桌面窗口，后台由插件管理。

插件服务日志默认在 `~/.pi/agent/pi-station/service-30141.log`。首次准备失败时，修复日志中报告的问题后重新运行命令即可。

`/station status` 在 pi 终端的对话区输出一条命令回复，不会固定在输入框上方。它是查询时的状态快照，再次查询可获取最新状态。后台管理进程运行不代表 Web 已启动，独立启动的 Web 服务也会单独显示。查询只更新界面，不调用模型或写入模型对话历史。

更新插件前先执行 `/station stop`，然后使用 pi 的包更新命令：

```bash
pi update --extensions
```

更新后重启 pi 或执行 `/reload`。

## 从源码独立使用

也可以直接克隆仓库开发或单独启动应用：

```bash
git clone "https://github.com/justinchoi929/pi-station.git"
cd "pi-station"
npm ci
npm run build
```

这是从源码安装的方式。`npm run build` 生成 Web 生产构建，供后续 Web 和桌面模式使用。已有开发服务运行时，请先停止它再构建，避免同时写入 `.next/`。

### 启动 Web

在仓库目录执行：

```bash
npm run web
```

服务就绪后会自动打开浏览器，也可以手动访问 [http://127.0.0.1:30141](http://127.0.0.1:30141)。默认仅监听本机。

不自动打开浏览器：

```bash
npm run web -- --no-open
```

`npm run web` 是 `node bin/pi-web.js` 的快捷方式。npm 负责执行脚本，实际后台由 Node.js 运行；对话由外部 pi CLI 执行。只读浏览会话不需要启动对话进程，模型列表查询可能短暂启动一个 pi 进程。

### 启动桌面客户端

在仓库目录执行：

```bash
npm run desktop
```

客户端先连接本地服务：

- 已有 Web 或开发服务时，直接复用，无须再启动一个服务。
- 没有服务时，自动启动生产服务，因此需要提前完成 `npm run build`。

从 Finder 启动时，客户端会读取登录 Shell 的环境，使后台能够找到终端中的 Node.js 和 pi。

### 生成 macOS 应用

完成 Web 构建后执行：

```bash
npm run dist
```

应用位于 `dist/mac-*/Pi Station.app`，可以从 Finder 双击打开。

**当前 `.app` 是桌面启动壳，仍依赖打包时的仓库路径、`node_modules`、Web 构建和系统 Node.js，也需要独立安装的 pi。** 请保留仓库目录；它目前不是可脱离仓库分发的完整安装包。`npm run dist` 不会自动构建 Web，也不会打包 pi。

桌面端启动的服务日志位于 `~/Library/Logs/Pi Station/server.log`。

### 关闭独立启动的服务

| 启动方式 | 关闭方式 |
| --- | --- |
| 终端中运行 `npm run web` 或 `npm run dev` | 在对应终端按 `Ctrl+C`。 |
| 客户端自动启动了后台服务 | 按 `⌘Q`，或在菜单栏选择 **Quit Pi Station**。 |
| 客户端连接了已有的终端服务 | 退出客户端后，仍需在服务终端按 `Ctrl+C`。 |

关闭桌面窗口只会隐藏窗口；菜单栏图标和后台服务会继续运行。关闭浏览器标签页也不会停止服务或正在运行的对话。

## 配置

| 变量或参数 | 用途 | 默认值 |
| --- | --- | --- |
| `PI_STATION_PI` | 指定外部 pi 可执行文件，仅填路径，不附加命令参数。 | 从 `PATH` 查找 `pi` |
| `npm run web -- --port <端口>` 或 `PORT` | Web 生产服务端口，命令行参数优先。 | `30141` |
| `PI_STATION_PORT` | 插件及桌面客户端连接或启动服务时使用的端口，启动 pi 前设置。 | `30141` |
| `PI_STATION_HOME` | 覆盖桌面客户端使用的 Pi Station 仓库路径。 | 开发时为当前仓库，打包后为记录的仓库路径 |
| `--no-open` 或 `PI_WEB_NO_OPEN=1` | Web 生产服务启动后不自动打开浏览器。 | 自动打开 |
| `PI_WEB_APP_NAME` | PWA 安装名称。 | `Pi Station` |
| `PI_WEB_PASSWORD` | 启用浏览器密码登录。 | 未启用 |

例如，指定 pi 的绝对路径：

```bash
PI_STATION_PI="/absolute/path/to/pi" npm run web
```

为 Web 和桌面客户端使用同一个自定义端口：

```bash
# 终端一
npm run web -- --port 30142 --no-open

# 终端二
PI_STATION_PORT=30142 npm run desktop
```

插件模式则在启动 pi 前设置，例如 `PI_STATION_PORT=30142 pi`。`PI_WEB_NO_OPEN=1` 也可以禁止插件自动打开浏览器。

这些端口参数针对生产启动方式；`npm run dev` 的默认端口由开发脚本固定为 `30141`。

## pi 升级与扩展兼容

pi 由你独立安装和升级。升级后重启 Pi Station 服务，让新会话进程使用更新后的可执行文件；不需要同步 pi 源码。

- pi CLI 负责加载自己的扩展、Provider、MCP 服务和工具。
- 标准 RPC 交互（选择、确认、输入、编辑）、通知、状态栏和文本组件会转发到界面。
- 终端专用的 `custom()` UI 和组件工厂受 pi RPC 的能力限制。
- 原 Pi Web 内置的子智能体运行机制不会注入新的 CLI 会话；旧子智能体记录仍可查看，新的子智能体能力应由 pi 扩展提供。
- 固定版本的 npm pi SDK 依赖只安装在隔离的 Web 运行环境中，用于部分会话文件读取和设置兼容逻辑；pi 扩展本身不会加载这些物理 SDK 副本。对话执行使用的是 PATH 中的 pi。

实现细节见 [PI_STATION.md](./PI_STATION.md)。

## 开发

安装依赖后启动带热更新的服务：

```bash
npm run dev
```

地址仍为 [http://127.0.0.1:30141](http://127.0.0.1:30141)。如需同时查看桌面界面，在另一个终端运行 `npm run desktop`，它会连接现有开发服务。

**开发服务运行时不要执行 `npm run build`。** 两者共用 `.next/`，构建会干扰开发服务。需要生产构建时，先停止开发服务。

常用检查：

```bash
npm test
"node_modules/.bin/tsc" --noEmit
npm run lint
```

## 目录

```text
app/             Next.js 页面和 API 路由
components/      React 界面组件
hooks/           客户端状态和交互
lib/             pi RPC、会话、模型、文件和 Git 逻辑
bin/             Web 启动入口和 pi RPC 桥接扩展
extensions/      pi 插件的 /station 命令入口
runtime/         隔离 Web 运行环境的依赖清单和锁文件
desktop/         Electron 主进程、预加载和打包脚本
public/          静态资源和 PWA 文件
docs/            功能说明与开发笔记
demo/            保留的上游静态演示项目
```

架构和文件索引见 [AGENTS.md](./AGENTS.md)。

## 来源与许可证

基于 [agegr/pi-web](https://github.com/agegr/pi-web) 开发，保留上游 Git 历史及原有版权声明。

[MIT](./LICENSE)
