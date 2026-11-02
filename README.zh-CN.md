# tmux-web · tmux 管理台

[English](README.md) · **简体中文**

自托管的 tmux 会话 Web 管理台。它通过 SSH 连到若干台远程主机，把主机上的 tmux 会话变成
浏览器里的会话卡片、实时终端与资源监控，并内置接入体检、`linger` / `tmux.conf` 一键修复
与操作日志。

## 特性

- **会话总览** —— 按主机分组。每张卡片带 pane 的实时预览、窗口数、连接身份与最近活跃时间。
- **实时终端** —— xterm + WebGL 渲染器（失败自动退回 DOM），输出按二进制帧走 WebSocket。
  支持 attach / 只读 / 独占三种进入模式、多标签与 2×2 分屏、tmux 窗口切换、快捷键条与批量发送区。
- **终端交互** —— 输出里的网址可点击；**拖动即选中**（tmux 开着 `mouse on` 也能选，
  选中后自己 `Cmd/Ctrl + C`）；右键弹应用自己的菜单
  （复制 / 粘贴 / 全选 / 清屏 / 重连 / 关闭终端）。
- **服务器管理** —— SSH 凭据 AES-256-GCM 加密存储、主机指纹 TOFU、接入检查与一键修复。
- **系统设置** —— 采集频率、SSH / WebSocket 链路参数、终端滚动与历史行为、常用指令。
- **零原生依赖** —— 用 Node 内置的 `node:sqlite` 与无需编译的 `ssh2`。
  `npm ci` 不会触发 node-gyp，也不需要 Python / make / g++。

## 技术栈

| 侧 | 组成 |
| --- | --- |
| 后端 | Fastify 5 · @fastify/websocket · ssh2 · **node:sqlite**（Node 内置）· bcryptjs |
| 前端 | React 18 · Vite 6 · TypeScript（strict）· @xterm/xterm 5（+ fit / webgl addon）· 手写 CSS |
| 运行时 | Node **24+**（`node:sqlite` 在 22 下需要 `--experimental-sqlite`） |
| 部署 | 单进程，前后端同一进程（Fastify 同时托管 API 与构建产物） |

## 快速开始

### 源码运行

```bash
# 1. 前端：构建静态产物
cd web && npm ci && npm run build

# 2. 后端：装依赖并启动（默认 9301 端口）
cd ../server && npm ci && npm start
```

打开 <http://localhost:9301>。首次启动会建一个管理员账号（仅当用户表为空时执行一次）。

### Docker

```bash
docker pull docker.cnb.cool/blueteam0715/web-tmux:latest

docker run -d --name tmux-web -p 9301:9301 \
  -v /opt/tmux-web/data:/app/data \
  docker.cnb.cool/blueteam0715/web-tmux:latest
```

> ⚠️ 数据卷必须挂到 `/app/data` —— 凭据主密钥 `.secret` 与 SQLite 库都在里面。
> 丢了 `.secret` 就再也解不开已保存的 SSH 密码。**请把该目录纳入备份。**

镜像由 CNB 流水线构建（push `main` 出 `latest` + 短 SHA，push `v*` tag 出对应版本号），
不在服务器上 `docker build`。

## 配置

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `ADMIN_USER` | `admin` | 管理员用户名 |
| `ADMIN_PASSWORD` | `admin123` | 管理员口令 —— **对外暴露前必须改** |
| `PORT` | `9301` | 监听端口 |
| `DATA_DIR` | `<cwd>/data` | 数据目录（SQLite 库 + 凭据主密钥） |
| `WEB_DIST` | `server/../web/dist` | 前端静态产物目录 |

> `ADMIN_USER` / `ADMIN_PASSWORD` **只在首次建库时生效** —— 库建好之后再改这两个变量不会有任何效果。
> 改口令请登录后在「系统设置」里改（最小长度 6 位）。

## 工作原理

- 单个 Node 进程。Fastify 托管 `/api/*`、`/ws/terminal` 与 SPA；其余路径一律回 `index.html`，
  这样 hash 路由才能工作。
- 每个终端标签页是一条 WebSocket。输出按 ~16ms 合并后以二进制帧下发；不带 `?bin=1` 的旧前端
  仍会收到 base64 文本帧，因此新旧前后端可以任意组合。
- 所有主机操作都走 SSH 连接池，凭据按需解密，**从不回传浏览器**。
- 状态就是一个 SQLite 文件加一把主密钥，没有外部服务要跑。

## 目录结构

```
tmux-web/
├── server/                  # 后端，纯 ESM JavaScript（没有编译步骤）
│   └── src/
│       ├── index.js         # 入口：注册插件、静态托管、监听端口、启动心跳
│       ├── routes.js        # 全部 HTTP 路由 + 鉴权守卫
│       ├── ws.js            # /ws/terminal 终端 WebSocket 协议
│       ├── sshpool.js       # SSH 连接池、主机指纹 TOFU、状态心跳
│       ├── tmux.js          # tmux 命令封装与接入检查项
│       ├── crypto.js        # AES-256-GCM 凭据加解密
│       └── db.js            # SQLite 建表、设置读写、账号与会话令牌
├── web/                     # 前端
│   ├── public/fonts/        # 自托管可变字体（构建时被拷进 dist）
│   ├── scripts/             # 配色 / 对比度自检
│   └── src/
│       ├── App.tsx          # 外壳：左 rail + 顶部状态条 + 路由
│       ├── api.ts           # 唯一的后端调用出口
│       ├── styles.css       # 全站样式（单一 CSS 文件）
│       └── views/           # Login / Overview / Terminal / Servers / Settings / Dialog / SessionAdmin
├── AGENTS.md                # 本仓库的强制约束（改代码前必读）
└── Dockerfile / .cnb.yml    # 镜像构建与流水线
```

## 开发

```bash
cd web && npx tsc -b                      # 只做类型检查
cd web && npm run build                   # 类型检查 + 构建

# 后端是纯 JS，无类型检查，做语法自检即可
for f in server/src/*.js; do node --check "$f" || exit 1; done

# 自检脚本（改了配色 / 设计令牌后必跑，退出码非 0 即不达标）
node web/scripts/check-ansi-palette.mjs   # 终端调色板三处一致性
node web/scripts/check-contrast.mjs       # 前景色 WCAG AA 对比度
```

> **改代码前请先读 [`AGENTS.md`](./AGENTS.md)** —— 那是本仓库的强制约束，
> 包含目录边界、设计系统令牌表、部署流程，以及一批「不读就会踩」的坑
> （终端调色板三处必须同步、tmux 在非 UTF-8 locale 下把中文输出成 `_`、等等）。

## 安全说明

这是一个**能 SSH 到别的机器并执行命令**的管理台，请按生产级敏感系统对待：

- **不要裸奔在公网**。部署在内网，或至少加一层 Basic Auth / IP 白名单 / VPN
- 首次部署务必通过 `ADMIN_PASSWORD` 注入强口令
- SSH 凭据以 AES-256-GCM 加密存储，主密钥是数据目录里的 `.secret`（**别让它进版本库**）
- 前端**只写不读**凭据 —— 已保存的 SSH 密码不会回传到浏览器
- 删除服务器只删管理端的记录与凭据，**不会动目标机上正在跑的 tmux 会话**
