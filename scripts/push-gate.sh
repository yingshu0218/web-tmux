#!/usr/bin/env bash
# 推送闸门 —— 只有「用户在测试服务器上验收过」的提交才允许 push 到 CNB。
#
# 为什么需要这个闸门（AGENTS.md §6.4）：
#   线上 compose 用 `latest` + `pull_policy: always`，`push main` 会覆盖 `latest` 镜像。
#   所以一次推送事实上等于把候选版本装进上线的枪膛，不是中性的源码备份 ——
#   它必须由「用户的验收」把关，而不是由助手自己的 CDP/自检结果把关。
#
# 通过条件：标记文件第一行记录的提交 SHA
#   1) 是当前 HEAD 的祖先（或就是 HEAD）
#   2) 从该提交到 HEAD 之间，**没有改动会被打包进镜像的文件**
#
# 判定口径（"会不会进镜像"，不是"是不是代码"）：
#   - `.workbuddy/`（工作日志）、`AGENTS*.md`、`README*.md`（含 README.zh-CN.md 这类
#     多语言版本）→ 不进镜像，不要求重新验收
#   - `scripts/`（根目录，含本脚本）→ 不进镜像（Dockerfile 只 COPY web/ 与 server/），同上
#   - `web/` `server/` `Dockerfile` `.dockerignore` `.cnb.yml` → **进镜像或影响构建结果，必须重新验收**
#   另：`web/scripts/` 属于 web/，仍按"要验收"处理（保守）。
#   若将来某个目录开始进镜像，记得把它从上面的豁免里去掉。
#
# 用户验收后由助手记录：
#   git rev-parse HEAD > .git/USER-ACCEPTED
#   （可再写第二行备注，例如验收时间与结论）
#
# 紧急绕过（请说明原因）：
#   git push --no-verify          或          TW_PUSH_SKIP_GATE=1 git push

set -uo pipefail

HEAD_SHA=$(git rev-parse HEAD 2>/dev/null) || exit 0
REPO=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
MARKER=${TW_PUSH_ACCEPT_FILE:-$REPO/.git/USER-ACCEPTED}

[ "${TW_PUSH_SKIP_GATE:-0}" = "1" ] && { echo "⚠️  推送闸门被 TW_PUSH_SKIP_GATE 跳过"; exit 0; }

if [ ! -f "$MARKER" ]; then
  cat >&2 <<EOF
⛔ 推送闸门：没有找到用户的验收记录。

   规则（AGENTS.md §6.4）：必须先部署到测试服务器、由用户验收通过，才允许 push / 打 tag。
   助手自己的 CDP / 自检脚本通过 **不算** 验收。

   用户确认后记录：
       git rev-parse HEAD > $MARKER

   紧急绕过（请说明原因）：
       git push --no-verify
EOF
  exit 1
fi

ACCEPTED=$(awk 'NR==1{print $1}' "$MARKER")
if ! git cat-file -e "${ACCEPTED}^{commit}" 2>/dev/null; then
  echo "⛔ 推送闸门：验收记录里的 SHA 不是有效提交：${ACCEPTED}" >&2
  exit 1
fi

if [ "$ACCEPTED" != "$HEAD_SHA" ] && ! git merge-base --is-ancestor "$ACCEPTED" "$HEAD_SHA" 2>/dev/null; then
  echo "⛔ 推送闸门：验收的提交 ${ACCEPTED:0:7} 不是当前 HEAD ${HEAD_SHA:0:7} 的祖先。" >&2
  echo "   验收之后又产生了新提交，需要重新验收。" >&2
  exit 1
fi

CHANGED=$(git diff --name-only "$ACCEPTED..$HEAD_SHA" 2>/dev/null \
  | grep -vE '^\.workbuddy/' \
  | grep -vE '^(AGENTS|README)(\.[a-zA-Z-]+)?\.md$' \
  | grep -vE '^scripts/' || true)

if [ -n "$CHANGED" ]; then
  echo "⛔ 推送闸门：验收之后又改了会被打包进镜像的文件，需要重新验收：" >&2
  printf '%s\n' "$CHANGED" | sed 's/^/     /' >&2
  exit 1
fi

NOTE=$(sed -n '2p' "$MARKER" 2>/dev/null | cut -c1-70)
echo "✅ 推送闸门：验收记录 ${ACCEPTED:0:7}${NOTE:+  （${NOTE}）}"
exit 0
