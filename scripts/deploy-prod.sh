set -euo pipefail
cd /opt/tmux-web

echo "════════ 1) 备份 compose ════════"
BAK="docker-compose.yml.bak-$(date +%Y%m%d-%H%M%S)"
cp -a docker-compose.yml "$BAK"
echo "→ $BAK"

echo
echo "════════ 2) 旧镜像留回滚点 ════════"
OLD_ID=$(sudo docker inspect tmux-web --format '{{.Image}}')
echo "旧镜像: ${OLD_ID:0:20}"
echo "旧镜像 revision: $(sudo docker image inspect "$OLD_ID" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' 2>/dev/null || echo '(无标签)')"
sudo docker tag "$OLD_ID" docker.cnb.cool/blueteam0715/web-tmux:prev
echo "→ 已打上 :prev"

echo
echo "════════ 3) 升级前数据卷基线 ════════"
sudo md5sum /opt/tmux-web/data/.secret
sudo stat -c 'tmuxweb.db size=%s mtime=%Y' /opt/tmux-web/data/tmuxweb.db
echo "磁盘: $(df -h / | tail -1 | awk '{print $4" 可用"}')"

echo
echo "════════ 4) 拉取新镜像（失败即中止，不动容器）════════"
sudo docker compose pull

echo
echo "════════ 5) 重建容器 ════════"
sudo docker compose up -d

echo
echo "════════ 6) 健康检查 ════════"
for i in $(seq 1 20); do
  ST=$(sudo docker inspect tmux-web --format '{{.State.Health.Status}}' 2>/dev/null || echo unknown)
  echo "  [$i] $ST"
  [ "$ST" = "healthy" ] && break
  sleep 3
done
sudo docker ps --format '{{.Names}}\t{{.Image}}\t{{.Status}}' | grep -i tmux

echo
echo "════════ 7) 冒烟验证 ════════"
echo -n "首页: "; curl -s -o /dev/null -w 'HTTP %{http_code}\n' http://127.0.0.1:9301/
echo -n "未登录 /api/servers（应 401）: "; curl -s -o /dev/null -w 'HTTP %{http_code}\n' http://127.0.0.1:9301/api/servers
echo -n "未登录 /api/me（应 401）: "; curl -s -o /dev/null -w 'HTTP %{http_code}\n' http://127.0.0.1:9301/api/me
echo "启动日志:"; sudo docker logs tmux-web 2>&1 | tail -3 | sed 's/^/  /'
echo "线上前端产物哈希:"; curl -s http://127.0.0.1:9301/ | grep -oE 'assets/[a-zA-Z0-9_.-]+' | sort | sed 's/^/  /'

echo
echo "════════ 8) 升级后数据卷复核（应逐项一致）════════"
sudo md5sum /opt/tmux-web/data/.secret
sudo stat -c 'tmuxweb.db size=%s mtime=%Y' /opt/tmux-web/data/tmuxweb.db

echo
echo "════════ 9) 清理旧镜像（只删 dangling，:prev 已打标签会保留）════════"
echo "清理前磁盘: $(df -h / | tail -1 | awk '{print $4" 可用"}')"
sudo docker image prune -f
echo "清理后磁盘: $(df -h / | tail -1 | awk '{print $4" 可用"}')"
echo "现存 tag:"
sudo docker images docker.cnb.cool/blueteam0715/web-tmux --format '  {{.Tag}}  {{.ID}}  {{.CreatedSince}}' | head -6
echo -n "dangling 镜像数: "; sudo docker images -f dangling=true -q | wc -l | tr -d ' '

echo
echo "✅ 部署脚本执行完毕"
