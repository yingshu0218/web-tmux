# tmux 管理台 —— 单容器镜像（Fastify API + WebSocket 终端 + 前端静态资源）
#
# 两阶段构建：
#   阶段 1 在容器里构建前端（服务器永远不接触前端工具链）
#   阶段 2 只装后端生产依赖 + 拷入 dist
#
# ⚠️ 目录布局必须保持 `server/` 与 `web/dist` 同级：
#    index.js 用 `path.resolve(__dirname, '../../web/dist')` 解析静态目录，
#    层级错了的表现是整站 404、后端只回一句 `web dist missing`。
#
# 基础镜像用 node:24（与线上一致）：
#    后端用内置 `node:sqlite`，Node 22 需要 --experimental-sqlite，24 起无需 flag。

# ---------- 阶段 1：构建前端 ----------
FROM node:24-alpine AS web-builder
WORKDIR /build/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# ---------- 阶段 2：运行时 ----------
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production \
    PORT=9301 \
    DATA_DIR=/app/data

# 后端生产依赖。--omit=optional 是为了跳过 ssh2 的 cpu-features（纯性能优化，
# 但要在 alpine 上现场编译，需要 python/make/g++）—— 跳过它免装整套构建工具链。
COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --omit=dev --omit=optional && npm cache clean --force

COPY server/src ./server/src
COPY --from=web-builder /build/web/dist ./web/dist

# 凭据主密钥（.secret）、sqlite 库、已登记的服务器清单全在 /app/data。
# 声明成 VOLUME：裸跑 docker run 时状态也不会丢在容器可写层里。
VOLUME ["/app/data"]

ARG GIT_REVISION=""
LABEL org.opencontainers.image.title="tmux-web" \
      org.opencontainers.image.source="https://cnb.cool/blueteam0715/web-tmux" \
      org.opencontainers.image.revision="$GIT_REVISION" \
      org.opencontainers.image.description="tmux 管理台：会话总览 / 多 socket 探测 / WebSocket 终端"

EXPOSE 9301
CMD ["node", "server/src/index.js"]
