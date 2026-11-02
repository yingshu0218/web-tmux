#!/usr/bin/env bash
# 把当前 main 的**当前树**作为单个提交推到 GitHub 镜像仓库。
#
# 为什么不用普通的 `git push`：
#   本地历史里有脱敏前的旧提交（AGENTS.md / 工作日志曾写着真实 IP、域名、测试口令）。
#   直接 push main 会把这些历史一起推到一个 **public** 仓库，等于脱敏白做。
#   所以这里用 `git archive` 导出当前树 → 在临时目录重新 init → 单提交 → force push。
#   代价是 GitHub 上没有历史（这是刻意换来的），CNB 私有仓库保留完整历史。
#
# 门禁：推之前先扫一遍导出内容，命中「非回环的 IPv4」或「.fun 域名」就中止。
#   检查用通用模式而不是写死具体值 —— 脚本本身也要进公开仓库，不能把真值写回来。
#
# 用法：scripts/push-github.sh
set -euo pipefail
cd "$(dirname "$0")/.."

REMOTE="${GH_REMOTE:-git@github.com:yingshu0218/web-tmux.git}"
SOURCE_SHA=$(git rev-parse --short HEAD)

echo "═══ 1) 导出当前树 ═══"
EXPORT=$(mktemp -d)
trap 'rm -rf "$EXPORT"' EXIT
git archive --format=tar HEAD | tar -x -C "$EXPORT"
echo "→ $(find "$EXPORT" -type f | wc -l | tr -d ' ') 个文件"

echo
echo "═══ 2) 敏感值门禁 ═══"
# 注意：macOS 的 grep -E **不支持 \b 词边界**（GNU 扩展），写了会静默匹配失败。
BAD=$(grep -rEn --binary-files=without-match \
  '([0-9]{1,3}\.){3}[0-9]{1,3}|[a-z0-9-]+\.fun' "$EXPORT" \
  | grep -vE '(127\.0\.0\.1|0\.0\.0\.0)' || true)
if [ -n "$BAD" ]; then
  echo "✗ 导出内容里还有未脱敏的地址，拒绝推送：" >&2
  printf '%s\n' "$BAD" | head -10 | sed 's/^/    /' >&2
  echo "  真实值与占位符的对应关系见 .workbuddy/local-env.md（已 gitignore）" >&2
  exit 1
fi
echo "✓ 无公网 IP / .fun 域名"

echo
echo "═══ 3) 建单提交 ═══"
cd "$EXPORT"
git init -q -b main
git add -A
# 用 **引号版** heredoc：消息里有反引号（`<TEST_HOST>`），不引号会被当成命令替换
MSG_FILE=$(mktemp)
cat > "$MSG_FILE" <<'MSG'
chore: 同步 tmux-web 快照（脱敏）

自托管 tmux 会话 Web 管理台的当前快照。本仓库为只读镜像，开发在私有仓库进行。
来源提交：__SOURCE_SHA__

文档中的主机名 / 域名 / 口令已替换为 `<TEST_HOST>` 这类占位符。
MSG
sed -e "s/__SOURCE_SHA__/$SOURCE_SHA/" "$MSG_FILE" > "$MSG_FILE.done"
git -c user.name=yingshu0218 -c user.email=yingshu0218@users.noreply.github.com commit -q -F "$MSG_FILE.done"
rm -f "$MSG_FILE" "$MSG_FILE.done"
git log --oneline

echo
echo "═══ 4) 推送到 $REMOTE ═══"
git remote add github "$REMOTE"
# 每次都是全新历史，必须 force；这个仓库是只读镜像，没有别人往里推
GIT_SSH_COMMAND="ssh -o ConnectTimeout=15" git push --force github main

echo
echo "✅ 完成。校验："
echo "   git ls-remote $REMOTE"
