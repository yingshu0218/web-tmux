# AGENTS.md — tmux 管理台（tmux-web）项目约束

本文件是本仓库的**强制约束**。任何 AI agent 或协作者在改动本项目前必须先读本文件。
与本文件冲突的做法一律以本文件为准；确需突破某条约束时，先向用户说明理由并取得同意。

---

## 0. 项目是什么

一个**自托管的 tmux 会话 Web 管理台**：管理端通过 SSH 连到若干台远程主机，
把主机上的 tmux 会话以「卡片 + 实时终端 + 资源监控」的形式呈现在浏览器里，
并内置接入体检、linger/tmux.conf 一键修复、操作日志。

- 后端：Fastify 5 + @fastify/websocket 11 + ssh2 + **node:sqlite**（Node 内置，零原生依赖）+ bcryptjs
- 前端：React 18 + Vite 6 + TypeScript（strict）+ @xterm/xterm 5，**手写 CSS，无 Tailwind**
- 部署：单机 systemd 服务，前后端同一进程（Fastify 托管静态产物）

**技术选型是刻意压到零原生依赖的**（`node:sqlite`、不需要编译的 `ssh2`、无 Tailwind 构建链）。
不要引入需要 node-gyp / 原生编译 / 额外构建步骤的依赖，除非用户明确同意。

---

## 1. 目录结构与边界

```
tmux-web/
├── server/                     # 后端，纯 ESM JavaScript（不是 TS）
│   ├── package.json            # 只有 start 脚本
│   └── src/
│       ├── index.js            # 入口：注册插件、静态托管、监听端口、启动心跳
│       ├── routes.js           # 所有 HTTP 路由 + 鉴权守卫
│       ├── ws.js               # /ws/terminal 终端 WebSocket 协议
│       ├── sshpool.js          # SSH 连接池、执行、主机指纹 TOFU、状态心跳
│       ├── tmux.js             # tmux 命令封装与接入检查项
│       ├── crypto.js           # AES-256-GCM 凭据加解密
│       └── db.js               # SQLite 建表、设置读写、账号与会话令牌
├── README.md                   # 英文说明（GitHub 首页展示）
├── README.zh-CN.md             # 中文说明（顶部有互链，改一份记得改另一份）
├── .workbuddy/                 # 项目记忆与产出，**不要删除**
│   ├── memory/                 # 按日工作日志（append-only）+ MEMORY.md 项目长期约定
│   └── artifacts/              # 归档的验收截图等交付物
└── web/                        # 前端
    ├── index.html
    ├── vite.config.ts          # dev 代理 /api 与 /ws 到 localhost:9301
    ├── public/fonts/           # 自托管字体（构建时被拷进 dist/）
    ├── scripts/                # 两个自检：check-ansi-palette.mjs / check-contrast.mjs（见 §2）
    └── src/
        ├── main.tsx            # 挂载点，勿动
        ├── App.tsx             # 外壳：左 rail + 顶部状态条 + Quick Search + 路由；导出 toast / nav / NAV
        ├── api.ts              # 唯一的后端调用出口
        ├── types.ts            # 与后端对齐的类型
        ├── ansi.ts             # ANSI 转 HTML（会话预览用）
        ├── links.ts            # 终端内 URL 可点击（自实现 xterm ILinkProvider；见下条「链接」）
        ├── selection.ts        # 拖动选中 + 滚轮转发（见下条「选中与复制」；不做自动复制）
        ├── icons.tsx           # 16×16 线性图标集
        ├── usePolling.ts       # 统一轮询 hook + keepRef（见 §1「性能红线」②）
        ├── styles.css          # 全站样式（约 1270 行，唯一 CSS 文件）
        └── views/              # Login / Overview / Terminal / Servers / Settings / Dialog / SessionAdmin
```

### 逻辑地基 —— 纯视觉改动时禁止触碰

`web/src/{api,ansi,types,main}.ts`、`web/src/main.tsx`、**整个 `server/`**。
视觉改版的正确做法是只动 `styles.css` + `views/*.tsx` 的 JSX + `App.tsx` 的展示层。
若发现必须改上面这些文件才能实现某个视觉效果，说明方案有问题，先停下来跟用户确认。

### 终端链接（2026-11-01 加）

终端里打印出来的 URL 可以点击、在新标签打开，实现是 `web/src/links.ts`（自实现的
xterm `ILinkProvider`，刻意没引 `@xterm/addon-web-links` —— 理由与协议白名单写在文件头）。

改动或排查时守住这几条：

- **只认 `http(s)://` 与 `www.`**，不认裸域名，也不放行 `file://` / `javascript:` / `data:`。
  终端内容来自远端主机，不能让一段输出诱导浏览器去执行别的协议处理器。
- **Shift / Alt 按住时不跳转** —— 这两个修饰键在这里代表「我要选文本 / 我要给 tmux 发鼠标」。
- 它是**按需**的 buffer 行级 provider：只有鼠标移到某一行时才扫描那一行（并沿 `isWrapped`
  链拼出逻辑行），**不参与输出热路径**，对 §1 性能红线①的基线没有影响。
- 卸载必须 `dispose()`（和 webgl 在同一条清理链里）。漏了就是每开关一次标签泄漏一个 provider。
- 回归自检：`.workbuddy/artifacts/2026-11-01-终端链接可点击/`（浏览器实测 + 纯逻辑单测，
  里面也记了「pointerCursor 是 class 不是 inline style」这个坑）。

### 终端选中与复制（2026-11-01 加，2026-11-02 调整）

拖动选中由 `web/src/selection.ts` 负责，**只负责选中、不自动复制** —— 复制走用户自己 Cmd+C，
或者右键菜单里的「复制」（这两条路都实测过）。

**为什么需要它**：tmux 开着 `mouse on`，attach 时它会发 DECSET 1000/1002/1006，xterm 收到后执行
`_selectionService.disable()` —— 选择服务被整个停掉，拖动被翻译成 `\x1b[<…M` 发给 tmux。
所以那种环境下拖动**根本产生不了本地选区**（不是「选中后被取消」，是压根没选上）。

**做法**：把这三个 DECSET 挡在 xterm 之外（`afterOutput()` 在每帧输出解析后复查
`term.modes.mouseTrackingMode`，发现又被打开就补一条 DECRST）。**只骗前端，不动 tmux 侧设置。**

- **滚轮必须自己转发**：`attachCustomWheelEventHandler` 里构造 SGR 序列发给 tmux，
  copy-mode 滚动才照旧。代价是**鼠标点击不再上报给 tmux**（tmux 里点 pane 会失效）
  —— 本管理台是「一会话一终端」，影响很小，但要知道这是刻意的取舍。
- 滚轮序列不再经过 `term.onData`，所以「刚滚过 2 秒内打字自动退出 copy-mode」的时间戳
  要在 `onWheelUp` 回调里补记（`Terminal.tsx` 里已接好），否则退出逻辑会静默失效。
- ⚠️ **`execCommand` 兜底会抢焦点**：它必须临时 focus 一个隐藏 textarea，移除后焦点掉到 `body`，
  用户复制完接着打字就**没有任何反应**。`copyTermSelection()` 里会把焦点还给 `term.textarea`，
  别把那几行"多余"的还原逻辑删掉。
- 曾经做过「选中即复制」，2026-11-02 按用户要求去掉了：拖动途中每格都会触发、还会抢焦点。

**这几条路已经试过，别再走**（都实测无效，别浪费一轮）：

1. `mousedown` 里 `term.write('…l')` 再补发一个合成 `mousedown` —— write 是异步解析，
   补发的合成事件 xterm 不认（`hasSelection` 始终 false）。
2. 直接改 `term._core.coreMouseService._activeProtocol = 'NONE'` —— 不够。选择服务是初始化时
   按 `areMouseEventsActive` **一次性** disable 的，翻协议不会把它 enable 回来。

回归自检：`.workbuddy/artifacts/2026-11-01-终端选中复制/`（拖选保持、滚轮进 copy-mode、
打字退出 copy-mode、shell 模式不转发）。

### 终端右键菜单（2026-11-02 加）

终端画布上右键弹**应用自己的** `ContextMenu`（`Overview.tsx` 导出的那个，与侧栏会话项共用），
浏览器原生菜单由 `.term-pane` 上的 `onContextMenu` + `preventDefault()` 拦掉。

项：复制（无选中禁用）/ 粘贴 / 全选 / 清屏 / 重连 / 关闭终端。

四个别改回去的细节：

- **`rightClickSelectsWord: false`** —— xterm 这个选项默认值是 `isMac`，也就是 macOS 上
  右键会把当前选区改成一个词，和菜单里的「复制当前选区」直接打架。
- xterm 自己也监听 `contextmenu`（把 textarea 挪到鼠标下，方便 Cmd+V 粘到正确位置），
  **但它不 preventDefault** —— 所以原生菜单只能靠自己拦。
- **「清屏」发 `Ctrl+L`**，不要用 `term.clear()`：后者只抹掉前端画布，下一次输出 / resize
  又把内容刷回来，用户会认为没生效。
- `ContextMenu` 的关闭监听要判 `e.defaultPrevented`：React 18 的委托在 `#root` 上、比 `window`
  先跑，不判就会「右键 → 先 setCtx(新) → 再被 window 关掉」，菜单闪一下消失。

回归自检：`.workbuddy/artifacts/2026-11-02-终端右键菜单/`。

### 性能红线（2026-09-30 量化诊断后立）

起因：用户报「浏览器功耗特别大、笔记本发热」。用 CDP 量化后定位到两条**必须持续遵守**的规则，
详细数据与复跑方法见 `.workbuddy/artifacts/2026-09-30-浏览器开销诊断/`。

**① 禁止用不可合成属性做无限动画。**
`animation: … infinite` 只允许动画 `transform` / `opacity`。
动画 `box-shadow` / `background` / `filter` / `width` 会**逐帧重算样式 + 重绘**，
并使页面永不进入空闲 —— 这是笔记本持续发热的直接原因。
需要脉冲/呼吸效果时，把动画放到伪元素上做 `transform: scale()` + `opacity`
（参考 `styles.css` 的 `.dot.online::after`）。

实测（**终端页 · 未开会话**这个场景）：主线程 4.1% → 0.2%，`RecalcStyleCount` 60/s → 0.1/s，
即该场景空载开销的 **95%** 来自这批动画。换到「开着 1 个空闲终端」的场景，
动画开启 7.0% → 关闭 2.7%，占比降到 61% —— **别把 95% 当成全站通用数字**，
它随「每帧样式树有多大」变化（终端挂载后节点更多，单帧更贵，但同时也多出终端自身的常数项）。

判据：**`RecalcStyleCount` 恒定等于刷新率（如 60/s）** 就说明踩了这条线。
修好之后这个数字应该掉到**个位数**，而不是 0 —— 详见下方「复跑判据」。

**② 轮询一律走 `usePolling`，不要写裸 `setInterval`。**
`web/src/usePolling.ts` 提供「页面隐藏即跳过、恢复可见补拉一次」，并配合
`keepRef` 在数据未变时保持引用稳定（否则下游 `memo` 会被无意义的 `setState` 打穿）。
回调会收到一个 `alive()`，**异步响应写回 state 前必须先判**，否则切换目标后
在途的旧响应会把过期数据写回去。周期约定：全局节点 15s / 会话树 5s / 节点资源 8s /
窗口 5s / 服务器页 10s / 总览预览卡 = `settings.previewInterval`
（每张卡自己轮询，**不要**再加全局 tick 去驱动它们）。

**③ `server/src/ws.js` 的输出帧格式已经改过，改它之前先读这一条。**
终端输出原先每块一条 `{t:'d', d: base64}` 文本帧，现在按 `?bin=1` 协商走
「~16ms 合并 + 二进制帧」。协商是**刻意**做的：新旧前后端任意组合都能工作
（旧前端不带 `bin` 就拿 base64）。**这是全仓库唯一一处被授权的 `server/` 例外**
（2026-09-30 经用户要求修 P2 时改动），其余 `server/` 文件仍受 §1 约束。

回归验证（改过 CSS 动画 / 渲染路径 / 输出协议后应复跑）：

```bash
cd .workbuddy/artifacts/2026-09-30-浏览器开销诊断
node browser-load-probe.mjs | tee after-fix-measurement.log   # 全场景
MODE=ab node browser-load-probe.mjs                           # 只看动画 A/B
```

**复跑判据**（2026-09-30 实测基线，测试站 1 台机 / 2 会话）：

| 场景 | 主线程 | 样式重算/s |
|---|---|---|
| 会话总览页 | ≤1.5% | ≤10 |
| 终端页 · 未开会话 | ≤1.5% | ≤10 |
| 终端页 · 1 个空闲终端 | ≤2% | ≤10 |
| 终端页 · 高速输出 | ≤3% | ≤20 |

- ☠️ **出现 `样式重算 = 60/s` 就是回归**，回去看 `animation: … infinite` 那几条。
  （当前残留是个位数 `/s`，来自 `.dot.online::after` 的脉冲 —— 已改成可合成属性，
  但在无头软件渲染下 Chrome 仍会周期性回主线程；代价约 0.4 个百分点，可接受。）
- ⚠️ 残留会**随状态点数量增长**（实测 4 个点 0.45%、64 个点 1.56%，16 倍数量约 3.5 倍开销）。
  若将来跑到几十台服务器仍觉得发热，下一个杠杆是**把脉冲限制在少数几处**或直接去掉它。
- 探针会顺带打印「输出帧 N 条（二进制 X / 文本 Y）」：**全是文本帧**说明 `?bin=1` 没生效，
  或服务端被回退成旧版；**一条都没有**说明终端输出链路坏了。

---

## 2. 常用命令

```bash
# 前端类型检查 + 构建（每次改动后必须跑）
cd web && npm run build          # = tsc -b && vite build

# 只做类型检查（更快）
cd web && npx tsc -b

# 后端语法自检（后端是纯 JS，无类型检查；用 node 解析即可）
for f in server/src/*.js; do node --check "$f" || exit 1; done

# 终端调色板一致性自检（改了 XTERM_THEME 或 ansi.ts 配色后必跑，退出码非 0 即不一致）
node web/scripts/check-ansi-palette.mjs

# 前景色对比度自检（改了 :root 的前景色或表面色后必跑，退出码非 0 即不达 WCAG AA）
node web/scripts/check-contrast.mjs
```

**禁止**在本机 `npm run dev` / `vite` 起 dev server 当作给用户验收的环境。
本机只用于改代码 + 跑 `tsc` / `build`。需要看界面时一律部署到测试服务器后给 URL。

同理，`cd server && npm start` 仅在必须复现后端逻辑时**短暂**使用（注意它会占用 9301 端口），
用完立即停掉，不要把它当作可交付环境。

---

## 3. 测试环境与部署（源码部署）

### 3.1 部署形态：**测试环境源码部署 + 镜像由 CI 产出**（v0.1.13 起）

这两种形态**并存，各有各的用途，不要互相替代**：

| | 测试环境部署（`<TEST_HOST>`） | Docker 镜像（CNB 制品库） |
| --- | --- | --- |
| 用途 | 开发中的验收环境 | 分发 / 生产 / 换机 |
| 怎么做 | 源码覆盖 + `systemctl restart` | CNB 流水线构建后 `docker pull` |
| 改动生效 | 秒级 | 走一次 CI（分钟级） |

**测试环境仍是源码部署**（这是刻意的：链路短、改完即生效、排错直观）：

- **后端**：`/opt/tmux-web/server/` 下就是**源码本身**（纯 ESM JavaScript，没有编译步骤、没有打包产物）。
  systemd 直接执行 `/usr/local/bin/node src/index.js`。改后端 = 覆盖 `src/` 下的源码文件 + 重启服务。
- **前端**：整个项目里唯一需要构建的部分。本地 `npx vite build` 产出 `web/dist`，
  上传到 `/opt/tmux-web/web/dist` 由 Fastify 静态托管。
  **不在服务器上构建**——服务器不装前端依赖、不跑 npm，只负责运行。

**镜像侧（`Dockerfile` + `.cnb.yml`）**：见 §3.3。两条通道独立，
**改了代码要发镜像时必须走 CI，不许在服务器上 `docker build`**（小规格云主机的内存峰值扛不住构建，
会连累同机的其它服务）。

### 3.2 测试环境

| 项 | 值 |
| --- | --- |
| 地址 | `http://<TEST_HOST>:9301/` |
| ssh 别名 | `devtest`（**不是** srv153；用户名 root） |
| systemd 单元 | `tmux-web-test` |
| 工作目录 | `/opt/tmux-web/server` |
| 静态产物 | `/opt/tmux-web/web/dist` |
| 数据目录 | `/opt/tmux-web/data`（`tmuxweb.db` + `.secret`） |
| 环境变量 | `PORT=9301`、`DATA_DIR=/opt/tmux-web/data`、`NODE_ENV=production` |
| 服务器 Node | v24.19.0（`/usr/local/bin/node`） |
| 测试账号 | `admin` / `<TEST_PW>`（临时弱口令，上线前必须改） |

### 3.3 Docker 镜像（CNB 流水线构建）

**镜像地址**：`docker.cnb.cool/blueteam0715/web-tmux`（同名制品，路径 = 组织/仓库）

| 触发 | 产出 tag |
| --- | --- |
| push `main` | `latest` + `<短SHA>` |
| push `v*` Tag | `v0.1.13` 这类版本号 + `<短SHA>` |

> ✅ **打 Tag 不会动 `latest`**（`.cnb.yml` 的 `"v*": tag_push:` 只推版本号与短 SHA）——
> 所以「给已上线的那次提交补一个版本号」是安全的，不会把线上引用的 `latest` 换掉。
> 实测 2026-09-30：`v0.4.0` 构建完成后 `latest` 的 `sn` 仍是先前 push 构建的 `cnb-0tg-…`。
>
> ⚠️ **同一次提交的 push 构建与 tag 构建是两份不同的镜像**（源码相同、digest 不同），
> 而它们**都往同一个 `<短SHA>` tag 上推** —— 后跑的会覆盖先跑的。
> 所以 **`<短SHA>` 不是稳定的回滚锚点**（本例 `b631372d` 从 push 那次的 `ddd33dc7…`
> 变成了 tag 那次的 `59445756…`）。要钉版本请用 `v0.4.0` 这类版本号 tag。

```bash
# 拉取（制品库公开时无需登录）
docker pull docker.cnb.cool/blueteam0715/web-tmux:latest

# 运行：数据卷必须挂到 /app/data —— 凭据主密钥 .secret 与 sqlite 库都在里面
docker run -d --name tmux-web -p 9301:9301 \
  -v /opt/tmux-web/data:/app/data \
  docker.cnb.cool/blueteam0715/web-tmux:latest
```

**Dockerfile 的两个关键点**：

1. **目录布局必须保持 `server/` 与 `web/dist` 同级**（镜像里是 `/app/server/src` + `/app/web/dist`）。
   `index.js` 用 `path.resolve(__dirname, '../../web/dist')` 找静态目录，层级错了整站 404。
2. **基础镜像是 `node:24-alpine`**，与线上一致：后端用内置 `node:sqlite`，
   Node 22 需要 `--experimental-sqlite`，24 起无需 flag。
   依赖装的是 `npm ci --omit=dev --omit=optional` —— 跳过 ssh2 的 `cpu-features`
   （纯性能优化，但要在 alpine 上现场编译，得装 python/make/g++）。

**`.cnb.yml` 的坑**：顶层键匹配的是「分支名**或 Tag 名**」。
`main:` 配 `push:` 才管 main 分支；版本走 `"v*":` 配 `tag_push:`。
写成 `main: tag_push:` 匹配的是「名叫 main 的 Tag」，**流水线永远不触发且不报错**。

**验证顺序**：`cnb build get-build-status` → `cnb registries list-package-tags --slug blueteam0715/web-tmux --type docker`
（看到 `has_provenance: true` 与 `annotations.revision` = 提交 SHA 才算对）→ 真 `docker pull` 下来跑一次。

**冒烟验证在 CI 内做**（`.cnb.yml` 的 `smoke test` 阶段，每次构建必跑）：

起容器 → 断言日志出现 `listening on` → 校验 `/app/server/src/index.js` 与 `/app/web/dist/index.html` **同级**
→ 用**容器内的 node** 自检首页 200 且含 `id="root"`（不依赖构建节点装没装 curl）
→ 未登录访问 `/api/servers` 必须 401 → **镜像内不得存在 `*.db` / `.secret`** → 验完 `docker rm -f`。

其中最后一条（2026-09-28 加）值得单独说明：运行期数据**只能**来自 `/app/data` 卷，
镜像层里一个字节都不该有。它对应过一次真实疑问 —— 有人怀疑「测试数据被打包进容器了」，
查证后镜像是干净的，**但这类问题在构建日志里完全看不出来**：Dockerfile 一旦把
`COPY` 写成 `COPY . .`，或 `.dockerignore` 漏了 `data/`，数据就会被烤进镜像、
推到制品库、分发到别人机器上，而**构建照样成功、冒烟照样通过**。所以固化成断言。

放 CI 而不是部署到服务器试，理由有三：① **「构建成功 ≠ 能用」** —— 目录层级错了只表现为整站 404，
构建阶段完全看不出来；② 制品库是 **Private**，服务器 `pull` 需要 `docker login`，
把令牌外放到目标机是额外的风险面；③ CI 里跑的是刚 build 的镜像，验的就是这一份产物。

**拉取需要认证**（本仓库是 Private，实测未登录 pull 报 `no basic auth credentials`）：

```bash
docker login docker.cnb.cool -u <CNB 用户名> -p <个人访问令牌>
docker pull docker.cnb.cool/blueteam0715/web-tmux:v0.1.13
```

> ⚠️ 登录后凭据会落在目标机的 `~/.docker/config.json`。用完 `docker logout docker.cnb.cool` 清掉。
> 若希望免登录拉取，需要在 CNB 侧把仓库/制品库可见性调成公开 ——
> 镜像内**不含任何凭据**（`.secret` 与 sqlite 库都在 `/app/data` 卷里），公开的内容风险可控。

### 3.4 线上部署：`<PROD_DOMAIN>`（容器形态）

| 项 | 值 |
| --- | --- |
| 域名 | `https://<PROD_DOMAIN>`（TLS 由 nginx 终止） |
| 机器 | `<PROD_HOST>` / ssh 别名 **`1204pigeon`**（用户 `ubuntu`，免密 sudo） |
| 运行形态 | Docker 容器，`restart: unless-stopped` |
| 编排文件 | `/opt/tmux-web/docker-compose.yml`（镜像走 **`latest`** + `pull_policy: always`） |
| 数据卷 | `/opt/tmux-web/data`（`.secret` + `tmuxweb.db`，**与测试环境完全独立**。⚠️ 它**不是空库** —— 首次启动就会自动建 admin 账号，之后的数据都是运行期累积的） |
| nginx 站点 | `/etc/nginx/sites-available/sh-tmux.conf`（权威副本）→ `sites-enabled/` 软链 |
| 证书 | 复用 acme.sh 的泛域名 `*.<BASE_DOMAIN>`（`/etc/nginx/certs/`），**加子域不需要重签** |

**几个必须知道的坑**：

- **拉镜像的登录用户名是 `cnb`，不是个人账号名**。用 `cnb.cMPXRmKswEA` 会报
  `unauthorized`。正确写法：
  `printf '%s' "$TOKEN" | sudo docker login docker.cnb.cool -u cnb --password-stdin`
- **token 会过期，而报错完全看不出是过期**。实测（2026-09-28）：过期后所有 pull 报
  `401 Unauthorized` + `failed to resolve reference ...`，compose 与 docker 都不会提「凭据过期」，
  很容易误以为是用户名写错或制品库可见性问题。
  本机的 `~/.cnb/token` 是 JSON（字段 `access_token` / `expires_at` / `refresh_token`），
  先看 `expires_at` 再决定；恢复方式 —— **token 走 stdin，不要写进命令行**（会进 shell 历史与日志）：

  ```bash
  TOKEN=$(python3 -c "import json,os;print(json.load(open(os.path.expanduser('~/.cnb/token')))['access_token'])")
  ssh 1204pigeon "sudo docker login docker.cnb.cool -u cnb --password-stdin" <<< "$TOKEN"
  ```
- **`ubuntu` 不在 docker 组**（`/var/run/docker.sock` 是 `root:docker`），
  这台机器上所有 docker 命令都要 `sudo`。
- **WebSocket 必须放行且延长超时**：反代段要带 `Upgrade`/`Connection` 头映射，
  并把 `proxy_read_timeout` 提到 `3600s` —— 默认 60s 会把挂着的终端掐断。
- nginx 的 `map` 是全局作用域，**同名重复定义会报 `duplicate map`**。
  本站点用独立变量名 `$tw_conn_upgrade` 并自包含定义，避免与 `dailycheckin.conf`
  的 `$connection_upgrade`、`pw.conf` 的 `$vw_conn_upgrade` 互相牵连。
- 用 `curl` 测 WebSocket 必须加 `--http1.1`：HTTP/2 下 `Upgrade` 头不适用，
  请求会落到普通 GET 路由而返回 **404**，看起来像没配好。

**升级流程**（镜像走 `latest`，**不需要改文件**）：
`cd /opt/tmux-web && sudo docker compose pull && sudo docker compose up -d`

- compose 里必须配 **`pull_policy: always`** —— 少了它，`up -d` 在本地已有同名 tag 时
  **根本不会去仓库拉**，把 tag 改成 latest 等于没改（本地那份 latest 会一直被复用）。
- 想确认线上真的换了版本，**比对前端产物哈希最直接**（比 digest 可靠）：
  `curl -s http://127.0.0.1:9301/ | grep -oE 'assets/[a-zA-Z0-9_.-]+'`
  应与本地 `web/dist/assets/` 的名字一致。
- ⚠️ **`latest` 会随每一次 `push main` 变化**，包括纯 docs / 日志提交 ——
  实测 `d15ea7b`（只改了工作日志）同样触发了构建并覆盖 `latest`。
  所以「下次重启会不会拉到没验过的版本」不再由 compose 文件决定。
  要钉住某个确定版本，把 compose 的 tag 临时改写具体版本（如 `:v0.2.0`）再 `up -d`。
- ⚠️ **镜像 digest 与版本 tag 的 digest 不一样是正常的**：`latest` 与同内容的 `v0.2.0`
  是**两次独立构建**，源码相同但镜像 digest 不同（实测 `09472f15…` vs `2c331a48…`）。
  所以判断「线上跑的是哪个版本」**要看产物哈希，别只看 digest**。
  同理，`docker inspect 容器 --format '{{.Image}}'` 给的是**本地 image ID**，
  与 registry 的 manifest digest 是两回事，别拿它去和制品库 API 报的 digest 比。
- ✅ **最直接的版本判据是镜像上的 OCI revision 标签**（比 digest 和产物哈希都硬）：
  构建平台会把提交 SHA 写进去，一条命令就能回答「线上跑的是哪个提交」——

  ```bash
  sudo docker image inspect docker.cnb.cool/blueteam0715/web-tmux:latest \
    --format '{{index .Config.Labels "org.opencontainers.image.revision"}}'
  # → b631372d486dc1d8e4032e7175316eccef6000fb
  ```
- **`prune` 会顺带回收上一个 `:prev`**：新一次部署把 `:prev` 指向刚下线的镜像后，
  上一次的 `:prev` 就变成 dangling 被清掉（实测回收 37MB）。这是预期的 ——
  永远只保留**一个**回滚点。prune 的日志里会先出现一条 `untagged: <当前 :prev 的摘要>`
  但**后面没有跟着 `deleted:`**，那是 `latest` 从这个镜像上摘掉标签，镜像本身因为还挂着
  `:prev` 而保留 —— 别把它当成「回滚点被删了」。

#### 升级线上的**安全前提**：确认不会连带杀掉用户的 tmux 会话

重启容器时所有 WebSocket 会断（浏览器里的终端掉线、需要重连），**但 tmux 会话本体在被管理机上，
断开 attach 不等于结束会话** —— 前提是那条会话没有开 `destroy-unattached`。
一旦开了，管理台一断，tmux 会把会话连同里面跑着的进程一起销毁。

风险是真实存在的：这个选项**在会话管理面板里可切换**（`SESSION_OPT_SPEC.destroyUnattached`），
用户可能在某条会话上打开过。所以升级前必须实测，不能假设：

```bash
# 每条会话的 destroy-unattached 生效值（走管理台 API，不必直连被管理机）
# GET /api/servers/:id/sessions/:name/options  →  options.destroyUnattached.value  必须为 off
```

**升级前后各取一次会话快照并逐条比对** —— 会话名 / `created` / `windows` 三项必须完全一致
（`/api/sessions` 提供前两项，`windows` 同响应里就有）。

本次实测（2026-09-30，3 条会话：开发测试 `codebuddy`/`work`、泰国鸽 `codebuddy`）：
升级前 `destroy-unattached` 全部为 `off`；容器重建后三条会话的 `created` 与 `windows`
**完全未变**，只有泰国鸽那条的 `attached` 从 4 掉到 0 —— 说明那 4 个都是管理台自己开的
浏览器客户端，会话本体没受影响。

配套的两个低成本强证据：

- 升级前备份 compose；数据卷 `/opt/tmux-web/data` 是 bind mount，容器重建**不会动它**，
  但顺手核对 `.secret` 的 md5 与 `tmuxweb.db` 的 size+mtime 前后一致，就能把「数据没被碰」钉死。
- **旧镜像先留回滚点再清**：
  `sudo docker tag <旧镜像ID> docker.cnb.cool/blueteam0715/web-tmux:prev` → 再 `docker image prune -f`。
  `prune` 只删 dangling（未被任何容器引用），不会碰 `dailycheckin` / `vaultwarden` 这类在用的镜像。

> 顺带：登录与部署**合并成一次 ssh 调用**（token 走 stdin 的第一行，脚本走剩余 stdin），
> 既不需要分两次连线，token 也不会进任何命令行：
> `{ printf '%s\n' "$TOKEN"; cat deploy.sh; } | ssh 1204pigeon 'IFS= read -r T; printf "%s" "$T" | sudo docker login docker.cnb.cool -u cnb --password-stdin >/dev/null && bash -s'`

> ⚠️ **安全注意**：这是公网可达的管理台，而它的能力是「SSH 到别的机器 + 执行命令」。
> 首次部署用 `ADMIN_PASSWORD` 注入的是 24 位随机密码（`ADMIN_*` **只在首次建库时生效**）。
> 若要进一步收紧，可在 nginx 该站点加 Basic Auth 或 IP 白名单 —— 见 skill `nginx-basic-auth-protect`。
>
> ⚠️ **排查线上时不要顺手 `cat docker-compose.yml`**：那份文件里**明文躺着 `ADMIN_PASSWORD`**，
> 而它同时就是管理台的 admin 登录口令。一旦打印进会话记录 / 日志就等于泄漏。
> 需要确认镜像与卷挂载时，只看 `docker inspect` 或 `grep -v PASSWORD`。**已踩过一次（2026-09-30）。**

### 部署步骤

```bash
# 1. 本地构建
cd web && npm run build

# 2. 打包上传（一次 scp，不要逐步操作）
#    COPYFILE_DISABLE 与 --no-xattrs 缺一不可，两个参数各治一半问题（见下方实测）
COPYFILE_DISABLE=1 tar --no-xattrs -czf /tmp/tw-deploy.tgz -C web dist
# 注意必须写 -czf：BSD tar 在 --no-xattrs 之后会把不带 - 的 czf 当成文件名，
# 报 `tar: Must specify one of -c, -r, -t, -u, -x`（实测踩过）
scp /tmp/tw-deploy.tgz devtest:/tmp/

# 3. 服务器覆盖（先备份旧版，再解压；不要 rm -rf）
#    只换前端产物**不需要**重启：index.html 是 setNotFoundHandler 里每次请求现读文件的
#    （index.js:41），静态资源也直接读盘。只有改了 server/src 才 systemctl restart。
TS=$(date +%Y%m%d-%H%M%S)
ssh devtest "cd /opt/tmux-web/web && mv dist dist.bak-$TS && tar xzf /tmp/tw-deploy.tgz \
  && chown -R root:root dist && systemctl is-active tmux-web-test"
```

> ⚠️ **`$TS` 千万不要写成 `\$TS`**。写成转义形式等于把它交给**远端** shell 展开，
> 而远端没有 `TS` 变量 → 展开成空串 → 备份目录名变成 `dist.bak-`（无时间戳）。
> 后果很隐蔽：第一次不报错，第二次 `mv` 才发现 `dist.bak-/dist: Directory not empty`。
> （历史上有几轮部署的备份名一直是空的，直到某次 `mv` 失败才暴露。）

**macOS 打包的扩展属性问题（实测数据）**：macOS 的 tar 会往归档里塞
`LIBARCHIVE.xattr.*` 扩展头和 AppleDouble `._*` 影子文件。两个参数各治一半：

| 打包方式 | 归档条目 | xattr 扩展头 | `._*` 垃圾 |
| --- | --- | --- | --- |
| `COPYFILE_DISABLE=1` | 11 | 22 | 无 |
| `--no-xattrs` | 22 | 0 | 有（服务器上 `._dist` 就是这么来的） |
| **两者组合** | **11** | **0** | **无** |

只加 `COPYFILE_DISABLE=1`：解压端会刷一堆
`tar: Ignoring unknown extended header keyword 'LIBARCHIVE.xattr...'` 警告（无害但很吵）。
只加 `--no-xattrs`：会在服务器上散落 `._*` 文件。
`chown -R root:root dist` 同样不能省 —— 否则解压出来的属主是本机 uid（501），
服务器上出现过 `501:games` 的文件。

改动后端时同样打包 `server/src`，但**必须先备份 `data/`**（见 §4 数据库约束）。

### 部署结构硬约束

`index.js` 里 `WEB_DIST` 的默认值是 `path.resolve(__dirname, '../../web/dist')`，
systemd 又**没有**设置 `WEB_DIST` 环境变量。因此：

> **`server/` 与 `web/` 必须是同级目录**，且静态产物落在 `<root>/web/dist`。
> 调整目录布局会让前端整站 404（后端只返回 `web dist missing`）。

---

## 4. 后端硬约束

### 4.1 路由前缀

`@fastify/static` 以 `prefix: '/'` 挂在最外层，且 `setNotFoundHandler`
把**所有非 `/api/`、非 `/ws/` 的请求都回 `index.html`**（hash 路由的 SPA 兜底）。

> 新增后端路由**必须**放在 `/api/` 或 `/ws/` 前缀下，否则会被 SPA 兜底静默吃掉。

### 4.2 鉴权

`routes.js` 顶部的 `preHandler` 钩子对**所有** `/api/*` 强制校验 Cookie 会话，
只放行 `/api/login`。

> 新增接口默认就是受保护的，不需要也不应该自己写鉴权。
> 确需免鉴权的接口，必须显式加入白名单并说明原因（安全敏感，需用户确认）。

### 4.3 数据库：没有版本化迁移

`db.js` 用 `CREATE TABLE IF NOT EXISTS` 幂等建表，**不存在 schema 版本号或迁移机制**。

> 给已有表加列时，只改 `CREATE TABLE` 语句是**无效的**——老库不会重建。
> 必须额外写 `ALTER TABLE ... ADD COLUMN`，并兼容旧库（`PRAGMA table_info` 探测后再加）。
> 改动前必须备份 `/opt/tmux-web/data/tmuxweb.db`。

### 4.4 设置项白名单

`setSettings()` 会**静默跳过**不在 `DEFAULT_SETTINGS` 里的 key。

> 新增任何配置项，必须同时在 `db.js` 的 `DEFAULT_SETTINGS` 里加默认值，
> 否则前端保存看起来成功、实际被丢弃。

### 4.5 tmux format 分隔符

tmux 会把 `-F` 输出里的控制字符（`\t`、`\x1f` 等）替换成 `_`，导致字段错位。

> 分隔符必须用**可打印串**（当前为 `~|~`，见 `tmux.js` 的 `SEP`）。
> 绝对不要"顺手改成" `\t` 或 `\x1f`。

### 4.6 Shell 转义与输入校验

- 任何拼进远程命令的字符串**必须**过 `q()`（单引号包裹 + `'\''` 转义）
- 会话名**必须**过 `validName()`：`/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/`
- 前端传来的值一律视作不可信输入，先校验再用

### 4.7 ssh2 版本签名

ssh2 ≥ 1.15 的 `hostVerifier` 签名是 `(hostKey: Buffer, cb: (permitted: boolean) => void) => void`，
**不再返回布尔值**。改这里是安全敏感区域（TOFU 指纹校验），改动前必须跟用户确认。

> 附带行为：修改服务器的 `host` / `port` / `username` 会清空已记录的指纹（重新 TOFU），
> 这是刻意设计，不要"优化"掉。

### 4.8 非交互执行的 locale

`exec` 走的是非交互 channel，**不加载 profile / rc**，读到的 locale 是错的。

> 需要真实环境变量时必须用 `bash -lc '...'`（见 `checkLocale`）。

### 4.9 WebSocket 插件注册

`@fastify/websocket` 的 `register` **必须 `await`**，否则路由挂不上 WS 钩子，会静默降级成普通 HTTP 请求。

### 4.10 凭据加密密钥

`data/.secret`（mode 600）是 AES-256-GCM 的主密钥，**丢失后所有已存服务器凭据永久无法解密**。

> 禁止在日志、错误信息、接口响应里输出明文凭据或 `.secret` 内容。
> 备份 `data/` 时必须连 `.secret` 一起备份。

### 4.11 tmux 会话按 socket 隔离（强约束）

**tmux 的会话空间是按 socket 分区的**，不是「一台机器一个列表」：

| socket | 谁在用 |
| --- | --- |
| `/tmp/tmux-<uid>/default` | 每个用户的默认 socket（本管理台连的就是当前 SSH 用户这个） |
| `/tmp/tmux-<uid>/<name>` | `tmux -L <name>` 建的命名 socket |
| 任意路径 | `tmux -S /path` 完全自定义 |
| `$TMUX_TMPDIR/tmux-<uid>/*` | 设了 `TMUX_TMPDIR` 时 |

**只查默认 socket 会漏掉其它用户 / 命名 socket 上跑着的会话**（v0.1.11 之前的实现就是这样）。
`listSessions()` 现在遍历 `/tmp/tmux-*/*` 与 `$TMUX_TMPDIR/tmux-*/*`，返回 `{ sessions, sockets }`，
每个会话带 `socket`（**null = 当前用户的默认 socket**）与 `socketOwner`。

配套的硬规则：

- **凡是带 session 的操作都必须一起带 socket**：`capturePane` / `listWindows` /
  `killSession` / `setSessionMouse` / `ws.js` 的 attach 命令，一律走 `sockArg(socket)` 拼 `-S <path>`。
  漏掉的症状是「明明列出来了，点进去是空的 / 操作的是另一个同名会话」。
- **同名会话可以并存**（两个 socket 各有一个 `work`）。所以前端所有列表 key、`OpenTab.key`、
  `sessOf()` 的匹配都要带 socket 维度，`key={s.name}` 这类写法都是 bug。
- **socket 路径必须过 `validSocketPath()`**：它拼进以 root 执行的远端 shell，用的是
  **形状白名单**（绝对路径 / 只允许 `[A-Za-z0-9._/-]` / 不含 `..` / ≤200 字符），
  非法值一律降级成空串（= 默认 socket），绝不做「转义兜底」。
- **跳过死 socket 与空 socket**：`tmux -L foo kill-server` 会留下 socket 文件但 server 已退出，
  此时 `list-sessions` 无输出。**必须 `[ -z "$LS" ] && continue`**，否则会误报出
  一个「0 会话的 socket」（实测踩过）。
- `applyScrollSettings()` 刻意**只作用于默认 socket**：其它 socket 上的会话属于别的用户/工具，
  管理台不该改写它们的鼠标与历史设置。`createSession()` 同理，只往默认 socket 里建。
- 非默认 socket 的会话在 UI 上统一用**琥珀色 `socket · <owner>` 标签**标出（`.tag.socktag` /
  `.rail-sess .rs-sock` / `.term-tab .tt-sock`），终止确认框里额外加一句风险提示。
- 管理台通过 SSH 用户看到什么取决于该用户的权限：root 能看全部用户的 socket，
  普通用户只能看自己的（`/tmp/tmux-<uid>/` 是 0700）。这是环境限制，不是 bug。

> 复现多 socket 场景（测试用）：`tmux -L twprobe new-session -d -s probe-a`，
> 验完 `tmux -L twprobe kill-server` 并删掉 `/tmp/tmux-<uid>/twprobe` 残留文件。

### 4.12 attach 必须强制 UTF-8（`tmux -u`）

**ssh exec 是非交互的，环境里没有 `LANG`/`LC_ALL`**（实测 `locale charmap` = `ANSI_X3.4-1968`）。
tmux 据此认定 client 不支持 UTF-8，于是把 pane 里的**宽字符（中文）输出成 `_` 占位**。

> 症状极具误导性：pane 内部字节完全正确（`capture-pane` 能读到 `344 270 255 …` = 中文），
> 会话总览的**预览卡也正常**，只有 attach 到浏览器这条链路全是下划线。
> 一个中文会话名/中文输出会显示成 `__`，非常容易被当成字体或编码 bug 去找。
> v0.1.12 修：attach 命令一律加 `tmux -u`（tmux 官方的强制 UTF-8 开关，不依赖装了哪个 locale），
> 并在服务器存在 `C.UTF-8` 时先 `export LANG/LC_ALL`（**必须先用 `locale -a | grep` 探测**，
> 否则没有该 locale 的机器上 shell 会打印 setlocale 警告）。

**测试非 ASCII 内容的正确姿势**：不要通过 `ssh '<含中文的命令>'` 传参 —— 远端 locale 是 C，
参数在传输层就会被破坏（`ps` 里只能看到 `?`，实际字节也不对）。用**纯 ASCII 传参**：

```bash
# 「中文」的 UTF-8 八进制是 \344\270\255\346\226\207
tmux -L twprobe send-keys -t probe-a 'printf "\344\270\255\346\226\207 OK\n"' Enter
tmux -L twprobe capture-pane -p -t probe-a | head -1 | od -c   # 应看到 344 270 255 346 226 207
```
再用浏览器读 `.xterm-rows` 的 textContent 确认渲染结果（`含真中文: true` / 无 `_{2,}`）。

### 4.13 空 body 的请求不能带 `Content-Type: application/json`（v0.1.14 修）

Fastify 5 **对「声明了 JSON 但 body 为空」的请求直接拒绝**，返回：

```json
{"statusCode":400,"code":"FST_ERR_CTP_EMPTY_JSON_BODY","error":"Bad Request",
 "message":"Body cannot be empty when content-type is set to 'application/json'"}
```

后果是一整片功能静默失效 —— 凡是**没有 body 的 POST / DELETE** 全部 400：

| 接口 | 前端调用 | 用户可见表现 |
| --- | --- | --- |
| `POST /api/servers/:id/check` | `api.checkServer` | 添加服务器向导报错、卡在第 2 步 |
| `DELETE /api/servers/:id` | `api.deleteServer` | 删除服务器报错、删不掉 |
| `DELETE /api/servers/:id/sessions/:name` | `api.killSession` | 终止会话报错 |
| `POST /api/servers/:id/fix-linger` | `api.fixLinger` | 一键修复失效 |
| `POST /api/servers/:id/push-tmux-conf` | `api.pushConf` | 一键下发配置失效 |
| `POST /api/logout` | `api.logout` | 退出登录失效 |

**最阴的地方是它会在「副作用已经发生」之后才报错**：添加向导是先 `addServer`（入库成功）
再 `checkServer`（400）—— 用户看到「失败」，但那条服务器**已经在列表里了**。

**两层修复，缺一不可**：

1. **前端 `api.ts`**：`req()` 只在 `opts.body != null` 时才加 `'Content-Type': 'application/json'`。
   这是根因所在。
2. **后端 `index.js`**：`removeContentTypeParser('application/json')` 后重新注册一个
   `parseAs: 'string'` 的 parser，**空 body 走 `done(null, {})`**。
   这一层是为了兜住浏览器里缓存的旧前端。注意**不能顺手把解析失败也吞掉** ——
   非法 JSON 仍要 `err.statusCode = 400` 抛出去。

自检（部署后跑一遍，前两条必须 200 / 404，后两条必须仍 400）：

```bash
C=/tmp/ck.txt; B=http://<TEST_HOST>:9301
curl -s -c $C -X POST $B/api/login -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"111"}' >/dev/null
curl -s -b $C -X POST   $B/api/servers/1/check       -H 'Content-Type: application/json' -o /dev/null -w 'check: %{http_code}\n'      # 200
curl -s -b $C -X DELETE $B/api/servers/999999        -H 'Content-Type: application/json' -o /dev/null -w 'delete: %{http_code}\n'     # 404
curl -s -b $C -X POST   $B/api/servers -H 'Content-Type: application/json' -d '{bad' -w '非法JSON: %{http_code}\n' -o /dev/null       # 400
curl -s -b $C -X POST   $B/api/servers -H 'Content-Type: application/json' -d '{}'  -w '业务校验: %{http_code}\n' -o /dev/null      # 400
```

**附带约定**：前端 `req()` 的错误文案取值顺序是 `message || error || HTTP <status>`。
Fastify 的内置错误体里 `error` 恒为 `"Bad Request"`，只看它用户永远只能看到一句废话。

---

### 4.14 模板串里不能引用**正在解构**的变量（v0.3.1 修，P0）

```js
// ❌ 曾经的真实写法（server/src/tmux.js 的 killSession）
const { code, stderr } = await execQuiet(server, `... 2>/dev/null; echo DONE-${code}`, 10000);
```

模板串在 `const` 解构**完成之前**求值，访问 `code` 会抛
`ReferenceError: Cannot access 'code' before initialization`（TDZ）。

**这个 bug 的可怕之处在于它的表现**：

- 报错发生在**发起 ssh 之前** —— 目标机根本收不到命令，日志里也没有任何远端痕迹
- 路由层把它当普通异常返回 400，前端只显示一句「Cannot access 'code' before initialization」
- **「终止会话」功能因此从上线起就没成功过一次**，而 `op_logs` 里 `session_kill` 长期是 0 条 ——
  这个 0 才是唯一的线索（正常失败的路径会记日志，这里连日志都没写）

**正确写法**：让远端用 `$?` 回传退出码，本地只读 `stdout`：

```js
const script = `if ! tmux ${S} has-session -t ${q(name)} 2>/dev/null; then echo 'ERR-会话不存在'; exit 0; fi
OUT=$(tmux ${S} kill-session -t ${q(name)} 2>&1) && echo 'OK-KILLED' || echo "ERR-$OUT"`;
const { stdout } = await execQuiet(server, script, 12000);
```

**排查同类问题的方法**（已用脚本扫过一遍，当前为 0 处）：
找出所有 `const { a, b } = await exec...(..., \`...${a}...\`)` 形式 ——
即模板串里出现了解构目标自身的名字。

> 同类教训见 §4.13：那也是一个「写法看起来无害、整个功能静默失效」的坑。

---

## 5. 前端约定

### 5.1 调用后端只能走 `api.ts`

组件里**禁止**裸写 `fetch`。新接口先加到 `api.ts`（`api.xxx`），再在视图里调用。
`api.ts` 已统一处理 401 跳登录、错误封装（`ApiError`）、`credentials: 'same-origin'`。

### 5.2 禁止原生弹窗

**禁止**使用 `window.confirm` / `window.prompt` / `window.alert`。

- 确认框 → `views/Dialog.tsx` 的 `confirmDialog`（Promise 化，支持 danger 红色风格与输入名称确认）
- 轻提示 → 从 `App.tsx` 导入的 `toast(msg, isErr)`

分级删除规则由设置项 `deleteConfirmLevel` 控制（`graded` / `always` / `never`），改删除流程时必须沿用。

### 5.3 设计系统（v0.2.0 起：现代 SaaS 暗色）

> **表面处理换了，品牌色没换。** 画布从「四级不透明 obsidian 堆叠」改成
> 「**玻璃 + 环境光晕 + 半透明卡面**」；电青 / 翡翠绿 / 琥珀 / 红四个语义色一个字没动。
> 令牌集中在 `styles.css` 的 `:root`，**新组件必须复用变量，不要写死颜色**。

| 用途 | 变量 / 值 |
| --- | --- |
| 画布基底 / 下沉面 | `--bg: #070a12` / `--bg2: #0b101b` |
| 玻璃面（rail / 状态条 / 登录卡） | `--glass: rgba(255,255,255,.04)` + `backdrop-filter: blur(40px)` |
| 卡片面料（L1） / hover | `--card: rgba(255,255,255,.045)` / `--card2: rgba(255,255,255,.06)` |
| 下沉输入框 | `--inset: rgba(0,0,0,.30)` |
| 不透明面板（模态 / 菜单 / 抽屉） | `--panel: #121724` / `--panel2: #161c2b` / `--panel3: #1f2634` |
| 描边 / 强描边 | `--border: rgba(255,255,255,.07)` / `--border2: rgba(255,255,255,.12)` |
| 主强调（电青） | `--primary: #00f2fe` |
| 状态色（翡翠绿） | `--accent: #4edea3` |
| 琥珀（重连中 / 非默认 socket / 身份不一致） | `--amber: #fbbf24` |
| 危险 | `--red: #f87171` |
| 前景三级（正文 / 次级 / 三级） | `#f8fafc` / `#94a3b8` / `#7d8ca1` —— 实测 18.9 / 7.1 / 4.6–5.8，**均达 WCAG AA** |
| 终端画布 | `#080b11`（**必须等于 `XTERM_THEME.background`**） |
| 圆角 | `--r-xs:6` `--r-sm:8` `--r:10` `--r-lg:14` `--r-xl:18` `--r-2xl:22` `--pill:999` |
| 阴影 | `--shadow-card`（卡片）；`--shadow-pop`（模态 / 菜单 / 抽屉） |
| 激活态 | `0 0 0 1px #00f2fe, 0 0 12px rgba(0,242,254,.15)` |

**五条硬约束**：

1. **圆角不许再收紧回 4/6/8。** 10–18px 的圆角尺度是这套方向的骨架；
   要更硬核的工业感就换整个风格，别单点改圆角。圆角档位不要越级使用：
   小标签 `--r-xs` / 按钮与输入 `--r` / 卡片 `--r-xl` / 浮层 `--r-2xl`。
2. **玻璃只给三处**：左 rail、顶部状态条、登录卡。**内容卡一律走半透明提升面**
   （`--card` + `--border` + `--shadow-card`）—— 给内容卡加 `backdrop-filter` 会糊掉终端预览文字。
3. **环境光晕是纯 CSS**：`.app` 上叠三层 `radial-gradient`（电青 / 翡翠绿 / 淡蓝），
   不新增节点、不引入图片。**绝不要给 `.app` 加 `backdrop-filter`** ——
   它会为 `position:fixed` 的抽屉 / 模态 / 命令面板造出新的包含块，
   让它们相对 `.app` 而不是视口定位（`.rail` / `.statusbar` 上可以用，它们不含 fixed 后代）。
4. **状态色语义全站统一**：翡翠绿 = 在线 / 活跃 / 成功；
   **琥珀 = 重连中 + 非默认 tmux socket + 连接身份与配置不一致**；中性灰 = 离线 / 无数据；红 = 破坏性操作。
5. **胶囊与按钮用自适应高度，不要写死 `height`**：圆角放大后，写死高度再用统一 padding 居中
   会产生纵向溢出（`height:26` + `padding:10` 要求 20px 纵向内边距，而文字行高只要 14px）。
   徽标 / 标签不写高度用 `padding: 3px 7px`；按钮不写高度用 `padding: 9px 14px`；定高容器给 `align-items:center`。

- 终端配色分布在 **三处，必须同步**（详见 §5.7）：`Terminal.tsx` 的 `XTERM_THEME`、
  `styles.css` 的终端画布 `#080b11`、`ansi.ts` 顶部的 `FG` / `BRIGHT`。
  **v0.2.0 改版刻意没有动这三处任何一个字节** —— 视觉改版不需要碰终端调色板。
- 字体：Inter（界面）+ JetBrains Mono（终端 / 等宽），自托管在 `web/public/fonts/`；
  中文回退系统 PingFang SC，**不要引入 CDN 字体**
- **字体用可变字体（v0.2.0 起），不要退回静态字重**。`public/fonts/` 里是 4 个文件：
  `{inter,jetbrains-mono}-{latin,latin-ext}-var.woff2`，在 `fonts.css` 里以**区间**
  声明字重（Inter `100 900` / JetBrains Mono `100 800`）。

  > 旧版 fonts.css 声明了 12 条 `@font-face`，但 src 全部指向仅有的 4 个 **400 字重**静态文件 ——
  > 除 400 外的字重全是浏览器合成加粗（faux bold），笔画发糊。而 KPI 数字（700）、
  > 会话名与编号徽标（600）恰好都落在假字重上。**换字体/加字重时必须确认该字重有真实字形**，
  > 验证方式：CDP 里枚举 `document.fonts`，看每条 FontFace 的 `weight` 是否为**区间**而非单值。

  ⚠️ **字体文件名有两个引用点，改名字时必须同时改**：
  ① `public/fonts/fonts.css` 的 `src`；② **`web/index.html` 的两个 `<link rel="preload">`**。
  漏改 ② 的代价：每次首屏白跑两个请求（落到 SPA 回退拿到 HTML）＋一次字体解析失败，
  而该预载的 var 字体反倒没被预载 —— 且**构建与页面都不会报错**，只能靠看 Network 发现。
- **首屏 JS 体积**：`/terminal` 视图走 `lazy(() => import('./views/Terminal'))` 按需加载
  （xterm 独占约 314KB，占总量的 59%）。首屏 JS 因此从 529KB（gzip 147KB）降到
  216KB（gzip 67KB）。**后续新增重型视图（图表、编辑器、播放器）照此办理**，
  别让它们挂在首屏 chunk 上；`Suspense` 的 fallback 用 `.view-loading`。
- 图标：统一用 `icons.tsx` 的 16×16 线性图标（`stroke=currentColor`），**不要引入图标库**；
  站点图标是 `public/icon.svg`（与 rail 品牌标记的 `>_` 同造型），**不要引二进制 .ico**
- 布局身份：**左侧持久 rail**（折叠 54px / 展开 **240px**，状态存 localStorage 的 `tw-rail`）
  + 顶部状态条（**64px**）。终端页有自己的一份 rail，复用 `App.tsx` 导出的 `NAV` 常量

### 5.4 删 CSS 类名前必须全项目搜索

`styles.css` 里保留了大量供 JSX 引用的类名。

> 删任何类名之前，必须先在 `web/src` 全目录搜一遍使用点。
> 经验证的自检方式：解析所有 `className` 出现，与 CSS 类名集合比对，要求零遗漏。

### 5.5 路由

hash 路由，`useHashRoute()` 解析 `#/path?a=b`。四个视图路径：
`/sessions`（总览）、`/terminal`（终端）、`/servers`（服务器）、`/settings`（设置）。
终端页参数：`?server=<id>&session=<name>&mode=attach|readonly|exclusive|shell`。
总览页参数：`?server=<id>`（按节点筛选，见 §5.6）。

`App.tsx` 导出的 `nav(path)` 是唯一的编程式导航入口。

### 5.6 导航唯一性：全局导航只在左 rail（强约束）
**左 rail 是全局唯一的导航与节点菜单来源。视图内部不得再放一份导航菜单、
节点侧栏或同类跳转控件** —— 否则屏幕上会同时出现两份同样信息。
（v0.1.6 删掉了总览页的 `.srv-list` 节点侧栏，就是这类重复。）

- 左侧 `HOST NODES` 节点列表由 `App.tsx` 渲染，全局仅此一处。
- **节点点击 = 按该节点筛选会话**，用 hash 传参：`#/sessions?server=<id>`；
  已在筛选态时再点同一节点 = 清除筛选（回 `#/sessions`）。
  非法参数（非数字）安全忽略，等价于无筛选。
- 页面内不重复渲染节点列表，筛选态由页头 `.srv-chip` 回显并可一键清除。
- 终端页（`/terminal`）不渲染全局 rail，用自带的 `side-rail`（复用 `NAV` 常量）——
  这是刻意的，终端需要独占横向空间，不算重复。
- 移动端（≤760px）rail 与 side-rail 都 `display:none`，由 `.bottomnav` 承担导航；
  此断点下节点筛选入口不存在，用页内搜索框输入节点名代替。

**判断标准**：新增任何"列表型"侧边控件前，先问一句
「这个信息左 rail 里有没有？」——有就不要加，改为增强 rail 或走 URL 参数。

**rail 折叠态必须有一个语义明确的展开入口（强约束）**：折叠后头部**只保留**
`.rail-expand`（`»`，34×30 的描边按钮，`title="展开导航"`），品牌 `.rail-brand`
与 `.rail-toggle` 在折叠态一律 `display:none`。

> 踩过的坑（v0.1.10）：折叠态原本用品牌 mark（`>_`）兼任展开按钮——功能是通的
> （实测点击能展开），但它与展开态的 logo **像素级相同**，用户直接报告
> 「折叠以后没有展开的地方」。**功能可用 ≠ 入口可发现**：凡是"能点但看起来像 logo"
> 的元素都要换成有按钮外观的图标。这条同样适用于 `.side-rail`（终端页）。

### 5.7 终端 ANSI 渲染：两套实现，必须同色

同一个 tmux pane 的内容会在**两处**独立渲染，颜色必须一致：

| 位置 | 实现 | 调色板来源 |
| --- | --- | --- |
| 终端工作区 `/terminal` | xterm.js（自带解析器） | `Terminal.tsx` 的 `XTERM_THEME` |
| 会话总览预览卡 | 自研 `ansi.ts`（SGR → 内联 CSS span） | `ansi.ts` 顶部的 `FG` / `BRIGHT` |

**硬约束：`ansi.ts` 的 `FG`/`BRIGHT` 必须与 `XTERM_THEME` 的 8 基础色 + 8 亮色逐项相同。**
反显兜底色 `DEF_FG` / `DEF_BG` 也必须等于 `XTERM_THEME` 的 `foreground` / `background`。

自检（改配色后必跑，退出码非 0 即为不一致）：

```bash
node web/scripts/check-ansi-palette.mjs
```

其余容易踩的点：

- **256 色（`38;5;n` / `48;5;n`）必须用标准算法**：索引 16–231 是 6×6×6 RGB 立方体，
  档位 `[0,95,135,175,215,255]`；232–255 是灰阶 `8 + (c-232)*10`。

  > 历史坑（v0.1.8 修复）：此前用 `hsl((c-16)*7.3, 62%, c%2?45:62%)` 近似，
  > **216 个索引零命中**，平均最大通道偏差 137/255。`38;5;196`（纯红 `#ff0000`）
  > 会渲染成 `#626eda` 蓝紫，`38;5;21`（纯蓝）会渲染成 `#ba822c` 橙棕。
  > 由于 xterm.js 走标准表，结果是**同一个 pane 在终端页是红的、在预览卡里是紫的**。
  > 这条路径真实存在：实测 `capture-pane -pe` 会原样保留 `38;5;n` 与 `38;2;…` 序列。

- **反显 SGR 7 必须有兜底**：只写 `\x1b[7m` 而未设 fg/bg 时，要用 `DEF_FG`/`DEF_BG` 补上，
  否则两个值都是 `undefined`，肉眼完全没有反相效果。带色的 `7;31;47` 不受影响。
- 粗体渲染为 `font-weight:600`，**不提亮为亮色**——xterm.js 默认会提亮，这是两处刻意的
  差异，不是 bug，不要"顺手对齐"。
- 非 SGR 的 CSI（`H` 定位、`J` 清屏）直接跳过：预览是静态快照，不需要光标语义。
- OSC 序列（改标题、OSC 8 超链接）只跳过、不生成 `<a>`，所以预览里点不了链接。
- 预览输出走 `dangerouslySetInnerHTML`，`escHtml()` 是安全边界，**不要绕过它**。

### 5.8 终端滚轮：由 tmux `mouse` 选项决定，两条通路互斥（强约束）

滚轮在本项目里**没有"浏览器本地滚动"这条路**——tmux 自己管屏幕、用光标定位重绘，
xterm 的 scrollback 恒为空（实测：已连上后往窗格灌 200 行，`scrollHeight == clientHeight`）。
所以滚轮只有两种可能，由**服务端 tmux 的 `mouse` 选项**决定：

| 模式 | tmux `mouse` | 浏览器发出 | 效果 |
| --- | --- | --- | --- |
| `view` 查看输出（默认） | `on` | SGR 鼠标序列 `\x1b[<64;x;yM` | tmux 进 copy-mode，可翻到**连接之前**的输出 |
| `keys` 历史输入 | `off` | `\x1bOA` / `\x1bOB`（= ↑↓） | 方向键被**灌进 pane**，等于调 shell 命令历史 |

**`keys` 不是"只读视角"，它会污染输入**——实测在 `demo-agent` 上滚轮直接留下了
`gecho MARKER`、`-bash: command not found` 这类痕迹。任何新增的滚轮相关功能都不允许
再引入"把滚轮翻译成方向键"的第三条路。

配置入口有两级，**必须成对维护**：

- 全局：`settings.scrollDefault`（`view`/`keys`）、`historyLimit`、`scrollExitOnInput`
  （`db.js` 的 `DEFAULT_SETTINGS`；`PUT /api/settings` 只要收到 `scrollDefault` 或
  `historyLimit` 就触发 `applyScrollSettings`，下发到所有在线服务器的全局 + 每个已存在会话）
- 会话级：`POST /api/servers/:id/scroll` `{session, mode}` → `setSessionMouse()`；
  终端页的下拉 `.scroll-sel` 走这条。会话级显式值**优先于**全局默认。

`ws.js` 的 `buildCommand()` 在 attach 前只对**没有显式 mouse 值**的会话按 URL 的 `&scroll=`
预设一次，已有显式值的保持不动（尊重用户在终端页的选择）。

**copy-mode 会吞键盘**（实测：进 copy-mode 后发 `echo KEY_REACHED_PANE`，`pane_in_mode`
保持 1、窗格零回显）。因此：

- `TermPane` 的 `term.onData` 与 `TerminalView.sendGuarded()`（发送框 / 键条）
  **都必须**在发送前判断是否处于历史视图，是则先补一个 `q` 退出。**新增发送通道时别忘了加**。
- 判据是「轮询到的 `inMode` 为真」或「5 秒内刚在终端里上滚过」——轮询有 5s 延迟，
  所以必须保留时间戳兜底。上滚时间戳由 `TermPane` 的 `onWheelUp` 回调上报。
- `q` 误伤代价是 shell 输入行多一个字符，可接受；用 `\x1b`（ESC）**不行**（会与后续按键
  组成 Alt 组合键）。

> 实测结论（v0.1.9）：**改 tmux 的 `mouse` 选项对已连接的 client 即时生效**，
> 不需要重连标签页——切换后第一次滚轮就已经换通路。这是 tmux 主动向 client
> 补发/撤销 DECSET 鼠标上报序列的结果，别自己写 `term.write('\x1b[?1000h')` 去模拟：
> 若 tmux 侧没同步打开，它会把这些序列当普通输入**透传进 pane**。

### 5.9 「以谁的身份连接」必须在页面上可见

**后端**：ssh 连接就绪时抓一次远端实际身份（`id -un` / `id -u`），存到 `sshpool` 的 `entry.ident`，
由 `getLiveStatus()` 暴露成 `live.ident`。**只在 `conn.on('ready')` 里抓一次，不进任何轮询循环** ——
它是慢变量，没必要反复取。

**前端**：`Overview.tsx` 导出两个纯函数，别在视图里各写一份文案逻辑：

- `connUser({username, host, port, live})` → `root@127.0.0.1`（**优先用实际身份**，退回配置 username）
- `connScope(live)` → `以 root（uid 0）连接 —— 可见全部用户的 tmux 会话`

展示位置（五处，都带 `title`）：

| 位置 | 形态 |
| --- | --- |
| 总览页服务器分组标题 | `.conn-user` 芯片（图标 + `root@host`） |
| 终端页信息栏 | 服务器名后的 `.conn-user` 芯片 |
| 服务器管理页 | 独立「连接身份」列：`root · uid 0` |
| 左 rail HOST NODES 节点行 | `.rn-user` 小胶囊（仅用户名，窄栏放不下 host） |
| Quick Search 服务器条目 | 副标题 |

**为什么必须做**：会话按 socket 隔离（§4.11），「某些会话看不到」是**权限决定的、正常的**。
页面不写清「现在以谁的身份在看」，用户一定会把它当成 bug 报上来。

**配置值与实际值不一致时**（`live.ident.user !== username`）用琥珀色 `.mismatch` 标出 ——
这通常意味着 sshd 配置、账号改名或 sudo 上下文有变化，值得让人一眼看到。

### 5.10 发送区：回车必须与文本**分两次**送达（v0.1.14 修）

发送区（`.compose textarea`，v0.3.2 起**默认收起**，定位见 §5.16）点「批量执行」时，
**不能**把 `文本 + '\r'` 拼成一个字符串写进 WebSocket。

**原因**：AI CLI（Claude Code / Codex 这类 TUI 输入框）会把「同一批到达的连续字符 + 换行」
识别成一次**粘贴**，于是那个 `\r` 只被当作粘贴内容里的换行，**不触发提交**。
用户看到的现象是「文本进了对话框，还得再按一次回车才能发出去」——
而这个多余的回车很容易被当成"上一条没发成功"，造成重复输入。

正确写法（`Terminal.tsx` 的 `sendDraft`）：

```ts
send(text);                                        // 文本
window.setTimeout(() => send('\r'), ENTER_GAP_MS); // 回车，单独一帧，间隔 80ms
```

**同时必须保证「退出历史视图」只做一次** —— 原实现是 `sendGuarded(文本 + '\r')`，
现在拆成两次发送后，若两次都调 `sendGuarded`，会在 copy-mode 下**补两个 `q`**（多出一个 q 进窗格）。
所以要在发送前算一次 `needExitHistory`，补完 `q` 就直接用裸 `send`。

**端到端验证方式（不要只看浏览器帧）**：`WebSocket` 帧分离只能证明前端拆了帧，
要证明「穿过 ssh pty + tmux 之后仍是两次独立的读」，在目标会话里跑一个 raw 探针：

```bash
tmux new-session -d -s zz-probe-raw
tmux send-keys -t zz-probe-raw "python3 -c \"
import sys,os,tty,termios,time
fd=sys.stdin.fileno(); old=termios.tcgetattr(fd); tty.setraw(fd)
log=open('/tmp/zz-probe.log','w',buffering=1); t0=time.time()
try:
    while True:
        d=os.read(fd,4096); log.write('%.3f len=%d %r\n' % (time.time()-t0,len(d),d))
except Exception as e: log.write('EXIT %r\n' % (e,))
\"" Enter
```

期望输出是**两条记录**（`len=11 b'hello-probe'` 与 84ms 后 `len=1 b'\r'`），
而不是一条 `len=12`。验完记得 `tmux kill-session`。

**回归**：拆分后普通 shell 里「文本 + 回车」仍要能正常执行命令（在 bash 会话里发
`echo XXX` 后 `capture-pane` 应看到回显与结果）。这条必须有，否则拆帧可能把命令拆坏。

---

### 5.11 顶部状态条只放全局控件，页面标题归内容区（v0.2.0 起）

状态条**不再显示页面标题**（`.sb-title` 已停用，`PAGE_TITLE` 常量已删）。
页面标题归内容区：各视图的 `.ov-head h2`（26px）+ 紧跟其后的 `.page-sub` 摘要行
（等宽字体、dim 色，写「N 台节点 · N 个运行中会话 · 预览每 N 秒刷新」这类**从已有 state 派生**的事实）。

理由：旧版状态条与内容区各写一份「会话总览」，是同一屏里的重复信息。
这条是 §5.6「导航唯一性」在**标题**上的同一条原则 —— **同一份信息在屏幕上只出现一次**。

状态条只保留三类东西：快速检索触发器、集群状态胶囊、账号菜单（`.user-chip` = 头像 + 用户名；
头像不要单独出现，一个孤零零的圆圈看不出是菜单）。

> 新增页面时：不要在状态条加标题，也不要在 `.ov-head` 之外再放第二份 h2。

### 5.13 无障碍与交互状态（v0.2.0 起，三条硬约束）

**① 三级前景色是实测达标的，改之前必须重跑 `node web/scripts/check-contrast.mjs`。**

旧值 `--dim: #64748b` 在卡片 / 表头上只有 **3.6–4.2**，**不达 WCAG AA（正文 4.5）** ——
肉眼几乎看不出来，但确实是缺陷（当时用它渲染了 page-sub、sess-meta、cfg-body、表头等一大批小字）。
v0.2.0 提到 `#7d8ca1` 后实测 4.6–5.8。
取值方法（复现像素级结论）：从**真实渲染截图**取 7×7 邻域**最暗**像素当背景 ——
文字恒比背景亮，直接取中心点会采到字形抗锯齿像素（第一次就这么采错了，表格那格虚高 60%）。

**② 焦点可见性全站统一，不要依赖浏览器默认样式。**
`:focus-visible` 给 `a / button / [tabindex] / summary` 一个
`2px solid var(--primary)` + `outline-offset: 2px` 的青色环。
**输入类元素（input / textarea / select）不要加 outline** —— 它们已有 `:focus` 的青色描边 + 光晕，
再叠一层框会脏。实测浏览器默认给的是 `auto 1px rgb(0,95,204)`，既弱又不属于这套语言。

**③ `prefers-reduced-motion` 的覆盖块必须放在样式表最末尾。**

媒体查询本身**不提升优先级**，同权重下「后写的胜出」。写在前面会被
`.dot.online { animation: pulse … }` 直接覆盖 —— **写了但不生效**（实测踩过，Tab 到状态点仍是 `pulse`）。

**改版验收的固定断言**：`document.documentElement.scrollWidth > innerWidth` 必须为 false。
圆角 / padding / gap 放大后横向溢出是最高频的回归；**375 / 1024 / 1440 三个宽度各查一遍**。

---

### 5.14 终端分屏：`tabs` 与 `slots` 必须是两层（强约束，v0.3.0 起）

`/terminal` 支持单屏 / 双屏 / 四分屏，**每个格子可独立挑会话**。实现上刻意分两层：

| 层 | 是什么 | 生命周期 |
| --- | --- | --- |
| `tabs: OpenTab[]` | **已打开的终端连接池**，每个各握一条 WebSocket | 只有 `closeTab` 才销毁 |
| `slots: string[]` | 长度 = 格子数，每格存一个 tab key（`''` = 空格子） | 随布局增删 |

> ⚠️ **渲染必须走 `tabs.map`，不能改成 `slots.map`。**
> `slots.map` 看着更直接，但那样切出视野的终端会被**卸载** —— 即断开 WebSocket、
> 丢掉 xterm 的 scrollback，切回来要重连且历史没了。
> 现在靠 grid 的 `order` 决定落位，不在 `slots` 里的一律 `display: none`：**隐藏但不卸载**。
>
> **验收断言**：切到单屏后 `document.querySelectorAll('.term-pane').length` 仍等于标签数。

其余几条：

- **`fit()` 只能作用在有实际尺寸的元素上。** 尺寸自适应用 `ResizeObserver` 监听终端容器
  （分屏切换 / rail 折叠 / 窗口缩放都会改尺寸），并在 `width < 40 || height < 30` 时跳过 ——
  否则隐藏中的元素会按 0 宽算出 **0 列**，还会把这个尺寸发给 tmux，把远端窗口一起带坏。
- **`active` 与 `visible` 是两个概念**：`visible` = 落在某个格子里（决定要不要 fit），
  `active` = 当前键盘输入目标（决定 focus 与描边）。**不要合并回一个布尔值。**
- 激活格用 **`outline`** 标记，不要用 `inset box-shadow` —— 后者画在内容之下，会被终端 canvas 盖住。
- 布局存 `localStorage` 的 `tw-layout`，但**只存布局、不存格子内容**：
  刷新后终端本来就要重连，恢复一个指向已消失 tab 的 `slots` 只会留下空壳。
- 窄屏（≤900px）双屏改**上下排列** —— 左右并排会把每个终端压到 20 来列，没法用。
- 分屏下若同一个 tmux 会话被两个格子同时 attach，tmux 会取**最小**尺寸 ——
  这是 tmux 的既有行为，不是前端的 bug。

### 5.15 会话管理：入口一致性 + 参数可靠性分级（v0.3.1 起）

**入口必须在两处都可达**。会话的运维操作（重命名 / 参数 / 窗口 / 终止）：

- 终端工作区：侧栏会话行尾**常驻**「⋯」（默认淡出、hover 变亮；`@media (hover: none)` 下常显）
- 会话总览：卡片「⋯」按钮 / 列表行「管理」/ 详情弹窗「会话管理…」

**侧栏为什么用常驻「⋯」而不是右键菜单**：用户反馈的原话是「看得到已有会话，但找不到删除、重命名」。
右键菜单没有任何可见性提示，正是这类「功能明明有、用户就是找不到」的典型成因。**别再用右键菜单当唯一入口。**

**「关闭视图」≠「终止远端会话」**，两者都在标签右键菜单里，且文案必须写全：

- `关闭视图（不影响远端会话）` —— 只关掉终端标签
- `终止远端会话` —— 真的杀 tmux 会话

原先只写「关闭标签」，极易被理解成删除会话。

**会话级参数的可靠性分级**（tmux 3.3a 实测，**别再凭直觉写 UI**）：

| 参数 | 稳定？ | 实测行为 |
| --- | --- | --- |
| `history-limit` | ✅ | 跨 `new-window` 保持（设 33333 → 新建窗口后仍 33333） |
| `mouse` | ✅ | 同上 |
| `window-size` | ⚠️ | **会话无客户端连接时，`new-window` 后会重置回 latest** |
| `destroy-unattached` | ⚠️ | 开启后**无客户端即立刻销毁整个会话**（实测：开启的瞬间会话就没了） |

- `destroy-unattached` 的开关**必须二次确认**（`confirmDialog` + `danger`）——
  它是这套 UI 里唯一一个「点错下拉框就等于删会话」的控件
- `window-size` 的价值（不干扰对方终端尺寸）**本应全局生效**，会话级只在有客户端期间有效；
  见 §10 待办

**`explicit`（是否显式设置）的判定**：`show-options -t <session> -v <opt>` 在会话级未设置时返回**空**，
所以用「空 ⇒ 继承」判断；`value` 取 `会话级 || 全局级` 以便 UI 显示实际生效值。
**不要**改用 `show-options -t <session>`（不带 `-v`）的列表 —— 它对 `window-size` 根本不输出条目。

**面板组件**：`views/SessionAdmin.tsx`，总览页与终端页**共用**，差异通过回调参数化
（`onRenamed` / `onKilled` / `onChanged`）。它刻意**不 import `Overview`**（总览页会反向引用它），
需要的那几行格式化函数就地重写，避免循环依赖。

**重命名必须同步已打开的标签**：`OpenTab.key` 里含会话名，改名后不同步 → 后续发送/切换会指向不存在的会话。
但 **React key 走 `OpenTab.uid`（创建后永不改变）** —— 否则改 key 会让 `TermPane` 重挂载，
WebSocket 断开、浏览器侧 scrollback 丢失。

> 与 §5.14 是同一个思路：**一个标识符承担太多职责就会互相打架**。
> 那里是 `tabs`（连接池）与 `slots`（格子映射）分离，这里是 `uid`（渲染身份）与 `key`（会话定位）分离。

---

### 5.16 输入模型：终端直通优先，发送区只做批量（v0.3.2 起）

**默认路径是终端直通**：`.xterm-helper-textarea` 拿焦点，`term.onData` → WebSocket
（`{t:'i'}`）→ `stream.write` → tmux。**打开会话后焦点就已经在终端上**，不用点、不用额外操作。

**发送区（`.compose`）默认只占一行、不渲染 textarea**，点「批量输入」才展开 ——
它只负责两件事：多行文本、批量执行命令。

**为什么「发送一段文本」替代不了键盘**（本节的核心理由）：

| | 终端直通 | 发送区 |
| --- | --- | --- |
| 送达方式 | **逐键** | 整段一次性粘贴 + 回车 |
| `/` 命令补全 | ✅ | ❌ 粘贴不是输入，agent 的补全读不到 |
| 退格 | ✅ 改的是终端里的内容 | 改的是本地草稿 |
| 方向键 / Tab / ^C | ✅ | 只能靠按键条逐个补 |
| 适用 | 交互式操作 | 长文本 / 批量命令 |

**实测结论**（tmux 3.3a + 测试环境，v0.3.2 验收）：

| 场景 | 结果 |
| --- | --- |
| 逐键 `echo HELLO_DIRECT` + 回车 | 上屏并输出 `HELLO_DIRECT` ✅ |
| `echo WRONGZ` → 退格 → 补 `OK` | 变成 `echo WRONGOK` ✅ |
| 逐键 `/help` | 正常上屏（补全依赖它）✅ |
| Ctrl+C | 正常中断 ✅ |
| **中文（终端直通）** | `中文` 正常上屏，**退格可删** ✅ |
| **中文（发送区）** | textarea 输入正常，送达 tmux 后被 bash 正确识别 ✅ |

**焦点管理**（三处，缺一不可）：

- 展开发送区 → `draftRef.current.focus()`
- 收起、或点「批量执行」发送完 → `focusTerminal()`
  （查 `.term-slot.active .xterm-helper-textarea`，不额外加 props 通道）
- 发送后把键盘交回终端是刻意的：批量执行完，用户要看的是终端输出

**一次性提示**：多数人不知道能点终端直接打字（以为必须用下面的输入框），
所以首次进入终端时浮一个 `.term-tip`，点「知道了」写 `localStorage['tw-term-tip-seen']` 后不再打扰。

> ⚠️ 提示的**计时必须从「打开会话」开始**，不能从组件挂载开始 ——
> 实测：登录 + 切页耗时 12 秒，按挂载计时的话提示在用户看到终端之前就过期了，**一次都没出现过**。
> 因此定时器 effect 的依赖要带 `hasActiveTab`（布尔），不要只看 `showTip`。

**中文输入的两条路径都要保住**：xterm 那条依赖 `tmux -u`（§4.12）；
发送区那条依赖 React 受控 textarea **不做异步 / 规范化处理**
（`onChange={e => setDraft(e.target.value)}` 直接同步写，否则会打断输入法组合）。

---

## 6. 变更与交付流程（用户偏好，强约束）

1. **先出方案再动手**：涉及多文件、多视图、架构选择的改动，先给方案 + 待拍板项，等用户确认后再执行。
2. **一次性合并**：用户倾向"把建议的改进一次做完"，而不是逐项递增上线。
3. **验收走测试服务器**：改完必须构建、部署到 `<TEST_HOST>:9301` 并给出可访问 URL。
   **不要**用本地端口/dev server 交差。
4. **先验收再推送（硬门，顺序不可颠倒）**：

   `打包 → 部署到测试服务器 → 用户在测试站验收通过 → 才 push / 打 tag`

   - **验收主体是用户，不是助手跑完 CDP / 自检脚本。** 自动化验证只是"自检"，
     不是验收，**不能作为推送依据**。
   - 未获用户确认前：可以提交到本地，**不得 push、不得打 tag**。
   - 已装机械闸门 `scripts/push-gate.sh`（`.git/hooks/pre-push`）：
     找不到验收记录就拒绝推送。用户确认后记录：
     `git rev-parse HEAD > .git/USER-ACCEPTED`
     只改 `.workbuddy/` 日志或 `AGENTS.md` / `README.md` 不要求重新验收（不进镜像）。
   - **为什么这条特别要紧**：线上 compose 用 `latest` + `pull_policy: always`，
     `push main` 会覆盖 `latest` 镜像 —— 一次推送事实上等于把候选版本装进上线的枪膛，
     不是中性的源码备份。
   - **违规记录（别再犯）**：`567ac23`（会话管理）、`887f9a5`（输入区折叠）
     都是助手在自检通过后**当轮直接 push** 的，用户没来得及在测试站验收。
5. **破坏性操作先确认**：删数据、改数据文件、改 schema、`rm` 类操作，一律先确认 + 先备份。
6. **合并命令调用**：涉及 ssh/scp 的多步操作，必须合并为「本地打包 → 一次 scp → 一次 ssh 执行脚本」，
   避免逐步执行反复触发审批。避免 `rm -rf` 这类高危写法。
7. **结论先行**：汇报时先给结论与关键数据，再给细节；不要大段铺垫。

---

## 7. 版本控制与 CNB 仓库同步

### 7.1 远程仓库

| 项 | 值 |
| --- | --- |
| 平台 | CNB（cnb.cool）|
| 组织 | `blueteam0715` |
| 仓库 | `blueteam0715/web-tmux` |
| 地址 | `https://cnb.cool/blueteam0715/web-tmux` |
| 可见性 | Private |
| 当前状态 | 已建立 `main` 分支，首次提交 `a2ce377`（35 个文件）|
| 操作账号 | 小蓝 / username `cnb.cMPXRmKswEA` |

> ⚠️ **本地目录名是 `tmux-web`，CNB 仓库名是 `web-tmux`（顺序相反）**。不要找错仓库。
> remote 名为 `origin`，地址 `https://cnb.cool/blueteam0715/web-tmux.git`。

### 7.2 推送方式（已在仓库内配置好）

仓库的 local config 已配好凭据助手与提交署名，**日常只需三步**：

```bash
git add -A
git commit -m "提交说明"
git push
```

已写入 `.git/config` 的配置（换机或重新 clone 后需重建）：

```bash
git config credential.helper '!cnb git-credential'
git config user.name  "cnb.cMPXRmKswEA"
git config user.email "cnb.cMPXRmKswEA@users.noreply.cnb.cool"
```

> 凭据由 CNB CLI 的 `git-credential` 助手动态提供，**不在仓库里存 token**。
> 提交署名固定用 CNB 账号，不要用本机全局身份。
> 推送时出现 `[git-credential]: ...` 提示属正常输出。

### 7.3 同步节奏

改动先在本地构建 + 测试服务器验收通过，**之后**再统一提交推送 CNB
（与 §6 的「先验收再推送」一致）。**不要**把未验证的改动推上去。

### 7.4 本机 git 环境（已修复，但机制脆弱，务必看）

**背景坑**：本机 `/usr/bin/git` 是 Xcode 的 shim，执行任何 git 命令都报
`You have not agreed to the Xcode license agreements`。
并且 **`brew install git` 同样走不通** —— Homebrew 自身也被同一个许可检查拦截，会直接失败。

**实际采用的方案**：绕开 shim，复用系统里自带的、**不受 shim 许可检查影响**的 git：

```
/Library/Developer/CommandLineTools/usr/bin/git         → 2.50.1 (Apple Git-155)  ← 当前使用
/Applications/Xcode.app/Contents/Developer/usr/bin/git  → 2.54.0 (Apple Git-157)
```

修复动作共两步，**缺一不可**：

```bash
# 1. 让 git 解析到 CLT 的 git（~/.local/bin 在 PATH 中优先于 /usr/bin）
ln -sf /Library/Developer/CommandLineTools/usr/bin/git "$HOME/.local/bin/git"

# 2. 修正 exec-path —— 这步最容易漏，漏了 push 必失败
#    Apple git 用 _NSGetExecutablePath() 推导 exec-path，该函数不解析 symlink，
#    于是它会去 ~/.local/libexec/git-core 找 helper，报
#      git: 'remote-https' is not a git command
#    即 commit 正常但 fetch/push 全废。用目录链接补上：
mkdir -p "$HOME/.local/libexec"
ln -sfn /Library/Developer/CommandLineTools/usr/libexec/git-core "$HOME/.local/libexec/git-core"
```

**若日后 git 再次报错，按顺序自查**：

```bash
command -v git                              # 应为 /Users/infinity/.local/bin/git
git --version                               # 应为 2.50.1 (Apple Git-155)
git --exec-path                             # 应为 /Users/infinity/.local/libexec/git-core
ls "$(git --exec-path)"/git-remote-https    # 必须存在，否则 push 必失败
```

⚠️ 这是**用户级修复**（写在 `~/.local/` 下，不属于项目文件），换机或清理 home 目录后需重做。
根治办法是让用户执行 `sudo xcodebuild -license` 接受许可。

---

### 7.5 GitHub 只读镜像（**public**）

`https://github.com/yingshu0218/web-tmux` 是对外公开的只读镜像，与 CNB 私有仓库并存。

⚠️ **不要**在本地仓库加 `github` remote 之后直接 `git push`：本地历史里有脱敏前的提交
（AGENTS.md 与工作日志曾写着真实 IP、域名、测试口令），直接推等于把它们送进公开仓库。

正确做法是 `scripts/push-github.sh`：

- `git archive HEAD` 导出**当前树** → 临时目录 `git init` → 单提交 → `--force` 推 `main`；
- 推之前跑门禁：导出内容里命中「非回环 IPv4」或「`.fun` 域名」就中止（用通用模式，
  不写死具体值 —— 脚本自己也要进公开仓库）；
- 所以 GitHub 上是**单提交、无历史**（刻意的），CNB 才是完整历史的权威库。

脱敏约定（新增文档/日志时别把真实值写回去）：

| 占位符 | 含义 |
| --- | --- |
| `<TEST_HOST>` / `<PROD_HOST>` / `<TG_HOST>` | 测试站 / 正式站 / 泰国鸽的公网地址 |
| `<CLIENT_IP>` | 本机出口 IP（曾出现在 op_logs 里） |
| `<PROD_DOMAIN>` / `<PW_DOMAIN>` / `<BASE_DOMAIN>` | 正式站域名 / 子域 / 主域 |
| `<TEST_PW>` | 测试站临时口令 |

真实值只写在 `.workbuddy/local-env.md`（**已 gitignore，绝不入库**）。

## 8. 本机环境坑

- **本机 `git` 依赖两个 symlink 才能用**（详见 §7.4）：一旦报错，按 §7.4 的四步自查，不要盲目重装。
- **macOS 没有 `timeout` 命令**，需要超时控制时用别的方式。
- **Bash 工具执行环境是 zsh**（v0.1.13 实测纠正了此前「POSIX sh」的错误结论：
  报错前缀是 `(eval):N:`、glob 不匹配报 `no matches found`、多行变量不分词，三处都是 zsh 特征）。
  写多步 shell 时注意三条：
  - **多行变量不会按换行分词**：`for r in $LIST` 会把整个多行串当成**一个**元素
    （报错形如 `operation not permitted: /tmp/bcnt-a\nb\nc.txt`）。
    要用 `while read -r r; do … done <<< "$LIST"`，且 `<<<` 才能让循环变量在**当前 shell** 累加。
  - `${...}` 会被 zsh 先解析一次：含 JS 模板字符串的脚本要先用 Write 落盘再执行，不要用 heredoc 内联。
  - 未匹配的 glob 会直接**中止命令**，写 `rm -f /tmp/x-*.txt` 这类通配前先想清楚目录是否可能为空。
- 无头 Chrome 截图会被沙箱 `SIGTERM`（exit 137），但**图片通常已经写盘**——先检查目标路径再判定失败。

---

## 9. 安全红线

- 服务器凭据只以密文形式存库；接口**只返回** `id/name/host/port/username/auth_type/fingerprint/created_at`，
  永不回传 `private_key_enc` / `password_enc`（`routes.js` 的 `serverCols` 即白名单）
- 任何"方便调试"性质的明文凭据输出、`console.log` 敏感值、放宽 `hostVerifier` 都是**禁止**的
- 本仓库服务于真实基础设施，`/api/servers/:id/*` 下的接口会真的操作远程主机
  （`fix-linger`、`push-tmux-conf`、`kill-session`、`scroll`），改动这些接口的语义必须先跟用户确认

---

## 10. 待办 / 已知债务

### 会话管理遗留（v0.3.1）

1. **`window-size` 应该做成全局设置，而不是会话级**。它的真实需求是「管理台这个浏览器客户端
   不要把自己的尺寸推给远端、挤到别人正在用的画面」—— 这是**服务器级**策略。
   按会话设既不稳定（无客户端连接时会被 tmux 重置，见 §5.15），也要逐个会话重复操作。
   落法：仿 `applyScrollSettings` 加一个 `applyWindowSize`，在系统设置里加一项后全量下发。
2. **窗口只有增 / 改 / 关，没有「切换当前窗口」**。管理台是 attach 模式，切窗口需要
   `select-window` 或给 pane 发按键；目前要在终端里自己敲。
3. **`session_create` 在 `op_logs` 里至今 0 条**。总览页有「+ 新建会话」入口，
   但从未被使用过 —— 不确定是没这个需求，还是与「终止会话」一样存在入口可见性问题。
   下次与用户确认。

### 视觉改版遗留（v0.2.0 只落了视觉层，这三项是**交互语义**变更，等用户拍板）

设计稿里画了、但**代码故意没动**的三处 —— 它们改变的是交互结构而非观感，
按 §6.5「破坏性操作先确认」的同一精神挂起：

1. **「接入检查」从模态改为页面内常驻面板**。稿子里把它做成服务器管理页的一张常驻卡片
   （4 个检查项 + 一键修复 / 下发 + 完成）。现状仍是逐行的模态弹窗。
2. **服务器表格列合并**：稿子把「延迟」与「会话数」并成一列、去掉了「tmux 版本」列，
   以换取更宽的操作列。现状保留全部 8 列（靠 `overflow-x` 横向滚动）。
3. **登录页 TOTP 区块**按「已预留、开关禁用」呈现 —— 这条现状已一致，无需改动，仅备查。

要落地 1 / 2 时：只动 `Servers.tsx` 的展示层，`/api/servers/:id/check` 的语义不变。

### 历史债务

- 测试账号 `admin` / `<TEST_PW>` 是弱口令：UI 改密接口强制 ≥6 位，**改短密码只能直接改库**，上线前统一处理
- `db.js` 缺 schema 迁移机制，未来若频繁改表结构，建议引入 `PRAGMA user_version` 版本化迁移
- ~~只读模式没有任何视觉反馈~~ → **v0.3.0 已修**：`.term-locked` 接上了（内描边 + 右上角角标），
  并且不再沿用原来的 `filter: grayscale(.9) brightness(.6); pointer-events: none` ——
  那会连滚动 / 复制 / 选文本一起禁掉，而只读模式的主要用途恰恰是「看」
- `web/dist` 与 `dist.bak-*` 备份目录混放在 `/opt/tmux-web/web/` 下。
  2026-11-02 复查：测试站只剩 1 个 `dist.bak-20260928-142924`（812K），
  `dist.prev` 已不存在（早先记录的 13 个 + 1 个已清理）。**但每次按「部署步骤」的
  `mv dist dist.bak-$TS` 都会再生成一个**，仍建议统一挪到 `/opt/tmux-web/backups/`
  并只保留最近 3 个。
  ⚠️ 这些备份目录**不受 Fastify 托管**（root 只指向当前 `dist`），所以不会造成
  「旧资源仍可访问」的问题；清理前确认 `root` 未被改到父目录即可。
- ~~CNB 同步尚未落地~~ **已完成**：`main` 分支首次提交 `a2ce377` 已推送至 `blueteam0715/web-tmux`
- 本机 git 是「用户级 symlink 修复」，不在项目内，换机后需按 §7.4 重做；
  根治建议用户执行 `sudo xcodebuild -license`
- 终端键条里的手机端 `PgUp` / `PgDn` 发 `\x1b[5~` / `\x1b[6~`，但 tmux root 表**没有**
  PageUp/PageDown 绑定，序列被透传给 pane，bash 默认忽略 → 点了没反应。
  修法：绑到 copy-mode 翻页（`bind -n PPage copy-mode -e \; send-keys -X page-up`）。
  这条目前靠「滚轮查看输出」替代，移动端可用性尚未与用户确认。
- `historyLimit` 改动**只对新建窗格生效**（tmux 的 history-limit 不可回填到已存在 pane）。
  要让历史变深必须重建会话，UI 说明里已注明，但后端没有做「重建会话」的动作。
