#!/usr/bin/env node
/**
 * 前景色对比度自检（WCAG AA）
 *
 * 为什么需要它：暗色主题里「三级前景」很容易掉到 4.5 以下而不自知 ——
 * 旧值 `--dim: #64748b` 在卡片/表头上只有 3.6~4.2，肉眼几乎看不出问题，但确实不达标。
 * 改 `:root` 里的任何前景色或表面色之前/之后跑一遍。
 *
 *   node web/scripts/check-contrast.mjs       # 退出码非 0 = 有不达标项
 *
 * 做法：从 styles.css 的 :root 读表面令牌 → 逐层合成出各层级背景 → 与前景令牌算对比度。
 * 背景是从令牌**算**出来的（不是写死的），所以改 --card / --glass 后本脚本会跟着变。
 */
import { readFileSync } from 'node:fs';

const CSS = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
const ROOT = CSS.match(/:root\s*\{([\s\S]*?)\n\}/)?.[1];
if (!ROOT) { console.error('× 找不到 :root 令牌块'); process.exit(1); }

function tok(name) {
  const m = ROOT.match(new RegExp(`--${name}:\\s*([^;]+);`));
  if (!m) { console.error(`× 缺少令牌 --${name}`); process.exit(1); }
  return m[1].trim();
}

/** '#rgb' | '#rrggbb' | 'rgba(r, g, b, a)' → {r,g,b,a} */
function parse(v) {
  let m;
  if ((m = v.match(/^#([0-9a-f]{3})$/i)))
    return { r: parseInt(m[1][0] + m[1][0], 16), g: parseInt(m[1][1] + m[1][1], 16), b: parseInt(m[1][2] + m[1][2], 16), a: 1 };
  if ((m = v.match(/^#([0-9a-f]{6})$/i)))
    return { r: parseInt(m[1].slice(0, 2), 16), g: parseInt(m[1].slice(2, 4), 16), b: parseInt(m[1].slice(4, 6), 16), a: 1 };
  if ((m = v.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i)))
    return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
  throw new Error(`无法解析颜色: ${v}`);
}

/** src 叠在 dst 之上 */
const over = (src, dst) => ({
  r: src.r * src.a + dst.r * (1 - src.a),
  g: src.g * src.a + dst.g * (1 - src.a),
  b: src.b * src.a + dst.b * (1 - src.a),
  a: 1,
});

const chan = c => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const lum = c => 0.2126 * chan(c.r) + 0.7152 * chan(c.g) + 0.0722 * chan(c.b);
const ratio = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const hex = c => '#' + [c.r, c.g, c.b].map(x => Math.round(x).toString(16).padStart(2, '0')).join('');

// ---- 表面层级：全部由令牌合成 ----
const bg = parse(tok('bg'));
const glass = parse(tok('glass'));
const card = parse(tok('card'));
const card2 = parse(tok('card2'));
const panel = parse(tok('panel'));
const primaryDim = parse(tok('primary-dim'));
const WHITE_03 = { r: 255, g: 255, b: 255, a: 0.03 };
const WHITE_05 = { r: 255, g: 255, b: 255, a: 0.05 };

const cardOnBg = over(card, bg);
const SURFACES = [
  ['画布 --bg', bg],
  ['下沉面 --bg2', parse(tok('bg2'))],
  ['玻璃面（rail / 状态条）', over(glass, bg)],
  ['卡片 --card', cardOnBg],
  ['卡片 hover --card2', over(card2, bg)],
  ['表格表头（卡 + 白 3%）', over(WHITE_03, cardOnBg)],
  ['模态面板 --panel', panel],
  ['激活底（--primary-dim）', over(primaryDim, bg)],
  ['半透明胶囊（卡 + 白 5%）', over(WHITE_05, cardOnBg)],
];

const FOREGROUNDS = [
  ['--text', parse(tok('text'))],
  ['--muted', parse(tok('muted'))],
  ['--dim', parse(tok('dim'))],
  ['--accent', parse(tok('accent'))],
  ['--primary', parse(tok('primary'))],
];

// 图形/大字号可用 3.0；这里一律按正文 4.5 卡，留足余量
const MIN = 4.5;

console.log('前景 × 表面 对比度（WCAG AA 正文门槛 %s:1）\n', MIN);
const head = '  ' + '前景'.padEnd(16) + SURFACES.map(([n]) => n.slice(0, 10).padEnd(13)).join('');
console.log(head);

const fails = [];
for (const [fn, fc] of FOREGROUNDS) {
  let row = '  ' + fn.padEnd(14);
  for (const [sn, sb] of SURFACES) {
    const r = ratio(fc, sb);
    const ok = r >= MIN;
    if (!ok) fails.push(`${fn} on ${sn} = ${r.toFixed(2)}（需 ${MIN}）`);
    row += `${r.toFixed(2)} ${ok ? ' ' : '×'}`.padEnd(13);
  }
  console.log(row);
}

console.log('\n合成出的表面色：' + SURFACES.map(([n, c]) => `${n.split(' ')[0]}=${hex(c)}`).join('  '));

if (fails.length) {
  console.error('\n× 不达标项：');
  for (const f of fails) console.error('   ' + f);
  process.exit(1);
}
console.log('\n✓ 全部前景色在所有表面上均达 WCAG AA');
