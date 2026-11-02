/*
 * 终端内 URL 可点击。
 *
 * 为什么自写 ILinkProvider 而不引 @xterm/addon-web-links：
 * ① 本仓库克制依赖（零原生编译是硬约束，纯 JS 也尽量少加），这里要的只是
 *    「在 buffer 行里找 URL + 点击打开」两件事，官方 addon 的额外能力（自定义 handler 选项、
 *    hoover 事件）这里用不上；
 * ② 默认 handler 是 window.open(uri, '_blank')，没有 noopener —— 被打开的页面能拿到
 *    window.opener 反向导航本管理台。自写可以顺手修掉。
 *
 * 行为约定（改动前先读）：
 * - **只认 http(s):// 与 www.**。不认裸域名（`index.js` / `foo.com:8080` 误报太多），
 *   也不放行 file:// / javascript: / data: —— 终端内容来自远端主机，不能让它诱导浏览器
 *   执行别的协议处理器。
 * - **普通左键点击即在新标签打开**。按住 Shift / Alt 不激活，留给「选区」与 tmux 鼠标操作。
 * - 支持被终端折行的长 URL：一个逻辑行（buffer 的 isWrapped 链）算作完整 URL，
 *   每次只返回与「被查询的那一行」相交的那一段（xterm 的 ILink 只带单个 range）。
 * - 宽字符（中文、emoji）按 **cell 列** 而非字符串下标映射。用 translateToString 的
 *   字符下标直接当列号会让下划线 / 点击区域整体左移（一个汉字差一列）。
 * - `pointerCursor` + `underline` 装饰由 xterm 自己画，styles.css 不用加东西。
 */
import type { IDisposable, IBuffer, IBufferLine, ILink, ILinkProvider, Terminal } from '@xterm/xterm';

/** http(s):// 或 www. 开头，直到空白或引号 / 尖括号（终端里常见的 URL 终止符） */
const URL_RE = /(?:https?:\/\/|www\.)[^\s\u0000-\u001f\u007f-\u009f"'<>]+/g;

/** 句末标点：几乎总是句子的一部分而不是 URL 的一部分 */
const TAIL_PUNCT = new Set([
  '.', ',', ';', ':', '!', '?', "'", '"', '”', '’', '、', '，', '。', '；', '：', '！', '？', '》', '】'
]);
/** 括号类：只有「右括号比左括号多」时才裁掉尾部那个（保住 Foo_(bar) 这种合法 URL） */
const PAIRS: [string, string][] = [['(', ')'], ['[', ']'], ['{', '}'], ['（', '）'], ['【', '】'], ['《', '》']];

function count(s: string, ch: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s[i] === ch) n++;
  return n;
}

/** 去掉 URL 尾巴上不属于它的标点 */
function trimTail(s: string): string {
  let out = s;
  for (;;) {
    const last = out[out.length - 1];
    if (!last) return out;
    const pair = PAIRS.find(p => p[1] === last);
    if (pair) {
      if (count(out, pair[0]) >= count(out, pair[1])) return out; // 成对 → 属于 URL
      out = out.slice(0, -1);
      continue;
    }
    if (TAIL_PUNCT.has(last)) {
      out = out.slice(0, -1);
      continue;
    }
    return out;
  }
}

/** 一行拆成「字符 → 所在列 / 显示宽度」，宽字符的续格（width 0）跳过 */
interface Row {
  y: number;
  text: string;
  /** 第 i 个 UTF-16 code unit 落在第几列（0-based） */
  cols: number[];
  /** 第 i 个 code unit 的显示宽度（1 或 2） */
  widths: number[];
  /** 该行在拼接串里的起始 offset */
  base: number;
}

function readRow(line: IBufferLine, y: number, maxCols: number): Row {
  const chars: string[] = [];
  const cols: number[] = [];
  const widths: number[] = [];
  for (let c = 0; c < maxCols; c++) {
    const cell = line.getCell(c);
    if (!cell) continue;
    const w = cell.getWidth(); // 0 = 宽字符续格，2 = 宽字符本体
    if (w === 0) continue;
    const s = cell.getChars();
    if (!s) {
      chars.push(' ');
      cols.push(c);
      widths.push(w);
      continue;
    }
    // 逐 code unit 展开，保证 text.length 与正则下标、cols 三者一一对齐
    for (let k = 0; k < s.length; k++) {
      chars.push(s[k]);
      cols.push(c);
      widths.push(w);
    }
  }
  // 裁掉行尾空白：否则 offset 会落到没有内容的列上
  let n = chars.length;
  while (n > 0 && chars[n - 1] === ' ') n--;
  return { y, text: chars.slice(0, n).join(''), cols: cols.slice(0, n), widths: widths.slice(0, n), base: 0 };
}

/**
 * 取 y 所在「逻辑行」的全部物理行。
 * isWrapped 的语义是「本行是上一行的折行延续」，所以向上要看**当前行**的标记，
 * 向下要看**下一行**的标记。
 */
function readLogicalRow(buf: IBuffer, y: number, maxCols: number): Row[] {
  const at = (n: number) => buf.getLine(n - 1) ?? null; // IBuffer.getLine 是 0-based，xterm 的 y 是 1-based
  let start = y;
  for (let guard = 0; guard < 500; guard++) {
    if (start <= 1) break;
    if (!at(start)?.isWrapped) break;
    start--;
  }
  let end = y;
  for (let guard = 0; guard < 500; guard++) {
    if (end >= buf.length) break;
    if (!at(end + 1)?.isWrapped) break;
    end++;
  }
  const rows: Row[] = [];
  let base = 0;
  for (let n = start; n <= end; n++) {
    const line = at(n);
    if (!line) break;
    const r = readRow(line, n, maxCols);
    r.base = base;
    base += r.text.length;
    rows.push(r);
  }
  return rows;
}

/** 全局 offset → 该行的列区间。返回 1-based 的「含首列」与「含尾列」 */
function toRangeX(row: Row, from: number, to: number): { x1: number; x2: number } {
  const i1 = from - row.base;
  const i2 = to - row.base - 1;
  return {
    x1: (row.cols[i1] ?? 0) + 1,
    x2: (row.cols[i2] ?? 0) + (row.widths[i2] ?? 1)
  };
}

/**
 * 给终端挂上 URL 点击。返回的 disposable 必须跟 term 一起释放
 * （否则 Linkifier 会把已 dispose 的终端留在监听链里）。
 */
export function attachLinks(term: Terminal): IDisposable {
  const provider: ILinkProvider = {
    provideLinks(y, callback) {
      const buf = term.buffer.active;
      if (y < 1 || y > buf.length) { callback(undefined); return; }

      const rows = readLogicalRow(buf, y, term.cols);
      const self = rows.find(r => r.y === y);
      if (!rows.length || !self || !self.text) { callback(undefined); return; }

      const joined = rows.map(r => r.text).join('');
      const links: ILink[] = [];
      URL_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = URL_RE.exec(joined))) {
        const trimmed = trimTail(m[0]);
        if (!trimmed || trimmed.length < 6) continue;
        const startOff = m.index;
        const endOff = startOff + trimmed.length;

        // 与本行取交集：跨行链接在其它行被查询时，各自只报自己那一段
        const segStart = Math.max(startOff, self.base);
        const segEnd = Math.min(endOff, self.base + self.text.length);
        if (segEnd <= segStart) continue;

        const { x1, x2 } = toRangeX(self, segStart, segEnd);
        const url = trimmed.startsWith('www.') ? `https://${trimmed}` : trimmed;
        links.push({
          range: { start: { x: x1, y }, end: { x: x2, y } },
          text: url,
          decorations: { pointerCursor: true, underline: true },
          activate(ev) {
            // Shift / Alt 按住时不跳转 —— 这两个修饰键在这里是「我要选文本 / 我要给 tmux 发鼠标」
            if (ev.shiftKey || ev.altKey || ev.button !== 0) return;
            // noopener：被打开的页面拿不到 window.opener，无法反向导航本管理台
            window.open(url, '_blank', 'noopener');
          }
        });
      }
      callback(links.length ? links : undefined);
    }
  };
  return term.registerLinkProvider(provider);
}
