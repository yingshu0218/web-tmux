/*
 * 让「拖动 = 本地选中」在 tmux 开了 mouse on 的情况下也成立。
 *
 * 只负责「能选中」，**不做选中即复制** —— 复制由用户自己 Cmd+C，或走右键菜单里的「复制」。
 * （曾经做过选中即复制，两个问题：拖动途中每格都会触发；execCommand 兜底还要抢焦点。）
 *
 * ── 为什么原来选不中 ──────────────────────────────────────────────
 * tmux 在 attach 时会发 DECSET 1000/1002/1006（鼠标上报），xterm 收到后做的事是：
 *
 *     this.coreMouseService.areMouseEventsActive
 *       ? (this._selectionService.disable(), this.element.classList.add('enable-mouse-events'))
 *       : this._selectionService.enable()
 *
 * 也就是**把选择服务整个停掉**，拖动被翻译成 `\x1b[<…M` 发给 tmux。
 * 所以拖动时浏览器里根本没有 xterm 的选区 —— 不是「选中后被取消」，是压根没选上。
 * （之前看到的那点高亮是 tmux 自己在 copy-mode 里的显示，松手重绘就没了。）
 *
 * ── 怎么绕 ──────────────────────────────────────────────────────
 * 把这三个 DECSET 挡在 xterm 之外（**只骗前端，不动 tmux 侧设置**）：
 * 终端输出解析完后查一次 `term.modes.mouseTrackingMode`，发现又被打开就补一条 DECRST。
 * 走的是 xterm 的公开输入路径，selection service 由 xterm 自己 enable/disable，状态自洽。
 *
 * 代价与补偿：
 * - 鼠标点击不再上报给 tmux（tmux 里点 pane 之类会失效；本管理台是「一会话一终端」，影响很小）；
 * - **滚轮必须自己转发**，否则 tmux 的 copy-mode 滚动就没了 —— 见 forwardWheel。
 *
 * ── 别踩的坑（都实测过）─────────────────────────────────────────
 * ① 在 mousedown 里 `term.write('…l')` 再补发一个合成 mousedown **没用**：write 是异步解析，
 *    补发的合成事件 xterm 不认（实测 hasSelection 始终 false）。只能走「常态关闭」。
 * ② 直接改 `term._core.coreMouseService._activeProtocol = 'NONE'` 也**不够** ——
 *    selection service 是在初始化时按 areMouseEventsActive 一次性 disable 的，
 *    只翻协议不会把它 enable 回来。别再试这条路。
 */
import type { IDisposable, Terminal } from '@xterm/xterm';

/** 关掉 xterm 的鼠标上报：X10(9) / VT200(1000) / DRAG(1002) / ANY(1003)。1006 只是编码格式，留着无害 */
const MOUSE_OFF = '\x1b[?9l\x1b[?1000l\x1b[?1002l\x1b[?1003l';

/** 非安全上下文（http 的内网地址）下 navigator.clipboard 不可用，退回 execCommand */
export function copyText(text: string): boolean {
  try {
    if (window.isSecureContext && navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(text).catch(() => { /* 权限被拒就算了，用户还能 Cmd+C */ });
      return true;
    }
  } catch { /* 落到下面的兜底 */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    // 不能用 display:none / visibility:hidden —— 那样选不中，execCommand('copy') 会返回 false
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
    ta.setAttribute('readonly', 'readonly');
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/**
 * 复制终端当前选区，返回复制的字符数（0 = 没有选中）。
 *
 * ⚠️ `execCommand` 兜底必须临时 focus 一个隐藏 textarea，移除后焦点会掉到 body ——
 * 这里统一把焦点还回 `term.textarea`，否则用户复制完接着打字**没有任何反应**（实测踩过）。
 */
export function copyTermSelection(term: Terminal): number {
  if (!term.hasSelection()) return 0;
  const text = term.getSelection();
  if (!text) return 0;
  const ta = term.textarea;
  const hadFocus = !!ta && (document.activeElement === ta || document.activeElement === document.body);
  copyText(text);
  if (hadFocus && ta && document.activeElement !== ta) {
    try { ta.focus({ preventScroll: true }); } catch { ta.focus(); }
  }
  return text.length;
}

export interface SelectionBridge {
  /**
   * 每次把终端输出写进 xterm **之后**调用（要写在 write 的回调里 —— write 是异步解析，
   * 紧接着读 modes 会读到旧值）。tmux 在 attach / 进 copy-mode 时会重新打开鼠标上报。
   */
  afterOutput(): void;
  dispose(): void;
}

export function installSelectionBridge(opts: {
  term: Terminal;
  /** 拿到当前终端的输入通道（未连接时返回 null） */
  getSend: () => ((d: string) => void) | null;
  /** 滚轮向上时通知外层（发送区要据此判断是否需要先退出历史视图） */
  onWheelUp: () => void;
}): SelectionBridge {
  const { term, getSend, onWheelUp } = opts;
  let hadMouse = false;
  let disposed = false;

  const silence = () => {
    if (disposed) return;
    try { term.write(MOUSE_OFF); } catch { /* noop */ }
  };

  const afterOutput = () => {
    if (disposed) return;
    if (term.modes.mouseTrackingMode === 'none') return;
    hadMouse = true;
    silence();
  };

  /*
   * 滚轮：tmux 那边仍然是 mouse on，所以自己构造 SGR(1006) 序列发给它，
   * copy-mode 滚动、以及「滚轮上 → 外层退出历史视图」的既有逻辑都能照旧。
   * 坐标固定填 1;1 —— tmux 只用 64/65 判断方向，滚的是「当前 pane」。
   */
  term.attachCustomWheelEventHandler(ev => {
    if (disposed) return true;
    const send = getSend();
    if (!send || !hadMouse) return true; // 没连上 / 这个终端从来没开过鼠标 → 交给 xterm 本地滚动
    const up = ev.deltaY < 0;
    send(`\x1b[<${up ? 64 : 65};1;1M`);
    if (up) onWheelUp();
    return false;
  });

  return {
    afterOutput,
    dispose() { disposed = true; }
  };
}
