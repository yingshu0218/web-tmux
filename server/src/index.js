import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerRoutes } from './routes.js';
import { registerTerminalWs } from './ws.js';
import { startStatusLoop, closeAll } from './sshpool.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 9301;
const WEB_DIST = process.env.WEB_DIST || path.resolve(__dirname, '../../web/dist');

const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });

// 空 body + Content-Type: application/json 时，Fastify 默认直接返回
// 400 FST_ERR_CTP_EMPTY_JSON_BODY —— 这会让所有「无 body 的 POST / DELETE」全部失败
// （接入检查、修复 linger、下发 tmux 配置、终止会话、删除服务器、退出登录）。
// 前端已改为只在带 body 时才声明 JSON；这里再兜一层，保证旧缓存页面或其它客户端也能用。
// 注意：JSON 内容本身不合法时仍然按 400 处理，不能把「解析失败」也吞成 {}。
app.removeContentTypeParser('application/json');
app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
  const raw = typeof body === 'string' ? body : String(body ?? '');
  if (!raw.trim()) return done(null, {});
  try { done(null, JSON.parse(raw)); }
  catch (err) { err.statusCode = 400; done(err); }
});

await app.register(cookie);
await app.register(websocket, { options: { maxPayload: 4 * 1024 * 1024 } });

registerRoutes(app);
registerTerminalWs(app);

if (fs.existsSync(WEB_DIST)) {
  await app.register(fastifyStatic, { root: WEB_DIST, prefix: '/' });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/') || req.url.startsWith('/ws/')) return reply.code(404).send({ error: 'not found' });
    return reply.type('text/html').send(fs.readFileSync(path.join(WEB_DIST, 'index.html')));
  });
} else {
  app.setNotFoundHandler((req, reply) => reply.code(404).send({ error: 'web dist missing', hint: 'build frontend first' }));
}

process.on('SIGTERM', () => { closeAll(); process.exit(0); });
process.on('SIGINT', () => { closeAll(); process.exit(0); });

app.listen({ port: PORT, host: '0.0.0.0' }).then(() => {
  console.log(`[tmux-web] listening on :${PORT}`);
  startStatusLoop();
}).catch(err => { console.error(err); process.exit(1); });
