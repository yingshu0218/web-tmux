// 校验 ansi.ts 的 FG/BRIGHT 与 Terminal.tsx 的 XTERM_THEME 逐项一致。
// 同一份 tmux pane 内容会在「终端工作区」(xterm.js) 和「会话总览预览卡」(ansi.ts) 两处渲染，
// 任一侧改色而另一侧没跟上，就会出现同一内容两种颜色。改动配色后请跑一次：
//   node web/scripts/check-ansi-palette.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const web = join(dirname(fileURLToPath(import.meta.url)), '..');
const ansiSrc = readFileSync(join(web, 'src/ansi.ts'), 'utf8');
const termSrc = readFileSync(join(web, 'src/views/Terminal.tsx'), 'utf8');

const grabList = (src, name) => {
  const m = new RegExp(`const ${name} = \\[([^\\]]+)\\]`).exec(src);
  if (!m) throw new Error(`未能在 ansi.ts 中找到 ${name}`);
  return m[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, ''));
};

const ansiColors = [...grabList(ansiSrc, 'FG'), ...grabList(ansiSrc, 'BRIGHT')];

const keys = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'];
const names = [...keys, ...keys.map(k => 'bright' + k[0].toUpperCase() + k.slice(1))];
const termColors = names.map(k => {
  const m = new RegExp(`[\\s{]${k}\\s*:\\s*'(#[0-9a-fA-F]{6})'`).exec(termSrc);
  if (!m) throw new Error(`未能在 Terminal.tsx 的 XTERM_THEME 中找到 ${k}`);
  return m[1];
});

// 顺带校验反显兜底色是否仍与 XTERM_THEME 的前景/背景一致
const defFg = /const DEF_FG = '(#[0-9a-fA-F]{6})'/.exec(ansiSrc)?.[1];
const defBg = /const DEF_BG = '(#[0-9a-fA-F]{6})'/.exec(ansiSrc)?.[1];
const termFg = /foreground:\s*'(#[0-9a-fA-F]{6})'/.exec(termSrc)?.[1];
const termBg = /background:\s*'(#[0-9a-fA-F]{6})'/.exec(termSrc)?.[1];

let bad = 0;
for (let i = 0; i < 16; i++) {
  const a = ansiColors[i].toLowerCase(), b = termColors[i].toLowerCase();
  if (a !== b) { bad++; console.log(`  ✗ ${names[i].padEnd(15)} ansi.ts=${a}  Terminal.tsx=${b}`); }
}
for (const [label, a, b] of [['DEF_FG / foreground', defFg, termFg], ['DEF_BG / background', defBg, termBg]]) {
  if (a && b && a.toLowerCase() !== b.toLowerCase()) { bad++; console.log(`  ✗ ${label.padEnd(15)} ansi.ts=${a}  Terminal.tsx=${b}`); }
}

if (bad === 0) console.log('  ✓ 16 色表 + 反显兜底色与 XTERM_THEME 完全一致');
else console.log(`\n  共 ${bad} 处不一致 —— 请同步 ansi.ts 与 Terminal.tsx 的配色`);
process.exit(bad === 0 ? 0 : 1);
