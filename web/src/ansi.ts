// Minimal SGR ANSI -> HTML renderer for preview panes (capture-pane -pe output)
// FG / BRIGHT 必须与 Terminal.tsx 的 XTERM_THEME 逐项一致：同一份 pane 内容在两个页面渲染，颜色必须相同
const FG = ['#3d4451', '#f2555a', '#5fd18c', '#e0b356', '#55a8ff', '#c678dd', '#4fc6d8', '#c5cdd7'];
const BRIGHT = ['#6a7383', '#ff7b7f', '#8ee6a8', '#ffd68a', '#79bcff', '#d99af0', '#7adfeb', '#ffffff'];
// 反显（SGR 7）在未显式设色时的兜底，取自 XTERM_THEME 的 foreground / background
const DEF_FG = '#dfe2f0';
const DEF_BG = '#080b11';
// xterm 256 色立方区档位（6×6×6 RGB），对应索引 16-231
const CUBE = [0, 95, 135, 175, 215, 255];

function xterm256(c: number): string | null {
  if (!Number.isFinite(c) || c < 0 || c > 255) return null;
  if (c < 16) return c < 8 ? FG[c] : BRIGHT[c - 8];
  if (c < 232) {
    const n = c - 16;
    return `rgb(${CUBE[Math.floor(n / 36)]},${CUBE[Math.floor(n / 6) % 6]},${CUBE[n % 6]})`;
  }
  const v = 8 + (c - 232) * 10;
  return `rgb(${v},${v},${v})`;
}

function escHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

interface Style { fg?: string; bg?: string; bold?: boolean; faint?: boolean; italic?: boolean; underline?: boolean; reverse?: boolean; }

function cssOf(s: Style): string {
  const parts: string[] = [];
  // 反显交换前后景；未显式设色的那一侧用终端默认色兜底，
  // 否则单独一个 SGR 7（不带 30-49）会算出两个 undefined，完全没有视觉效果
  const fg = s.reverse ? (s.bg ?? DEF_BG) : s.fg;
  const bg = s.reverse ? (s.fg ?? DEF_FG) : s.bg;
  if (fg) parts.push(`color:${fg}`);
  if (bg) parts.push(`background:${bg}`);
  if (s.bold) parts.push('font-weight:600');
  if (s.faint) parts.push('opacity:.55');
  if (s.italic) parts.push('font-style:italic');
  if (s.underline) parts.push('text-decoration:underline');
  return parts.join(';');
}

export function ansiToHtml(input: string): string {
  const out: string[] = [];
  let style: Style = {};
  let i = 0;
  const flush = (text: string) => {
    if (!text) return;
    const css = cssOf(style);
    out.push(css ? `<span style="${css}">${escHtml(text)}</span>` : escHtml(text));
  };
  while (i < input.length) {
    const ch = input[i];
    if (ch === '\x1b') {
      if (input[i + 1] === '[') {
        const m = /^([0-9;]*)([A-Za-z])/.exec(input.slice(i + 2));
        if (m) {
          const [, paramsStr, cmd] = m;
          if (cmd === 'm') {
            const params = paramsStr === '' ? [0] : paramsStr.split(';').map(Number);
            for (let p = 0; p < params.length; p++) {
              const v = params[p];
              if (v === 0) style = {};
              else if (v === 1) style.bold = true;
              else if (v === 2) style.faint = true;
              else if (v === 3) style.italic = true;
              else if (v === 4) style.underline = true;
              else if (v === 7) style.reverse = true;
              else if (v === 22) { style.bold = false; style.faint = false; }
              else if (v === 23) style.italic = false;
              else if (v === 24) style.underline = false;
              else if (v === 27) style.reverse = false;
              else if (v >= 30 && v <= 37) style.fg = FG[v - 30];
              else if (v === 39) delete style.fg;
              else if (v >= 90 && v <= 97) style.fg = BRIGHT[v - 90];
              else if (v >= 40 && v <= 47) style.bg = FG[v - 40];
              else if (v === 49) delete style.bg;
              else if (v >= 100 && v <= 107) style.bg = BRIGHT[v - 100];
              else if ((v === 38 || v === 48) && params[p + 1] === 5) {
                const color = xterm256(params[p + 2]);
                if (color) { if (v === 38) style.fg = color; else style.bg = color; }
                p += 2;
              } else if ((v === 38 || v === 48) && params[p + 1] === 2) {
                const color = `rgb(${params[p + 2]},${params[p + 3]},${params[p + 4]})`;
                if (v === 38) style.fg = color; else style.bg = color;
                p += 4;
              }
            }
          }
          i += 2 + m[0].length;
          continue;
        }
        i += 2; continue;
      }
      if (input[i + 1] === ']') {
        const end = input.indexOf('\x07', i);
        const end2 = input.indexOf('\x1b\\', i);
        i = end === -1 ? (end2 === -1 ? input.length : end2 + 2) : end + 1;
        continue;
      }
      i += 2; continue;
    }
    const next = input.indexOf('\x1b', i);
    const chunk = next === -1 ? input.slice(i) : input.slice(i, next);
    flush(chunk.replace(/\r/g, ''));
    i = next === -1 ? input.length : next;
  }
  return out.join('');
}

export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, '').replace(/\r/g, '');
}
