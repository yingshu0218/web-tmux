import { useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import { attachLinks } from '../links';
import { installSelectionBridge, copyTermSelection } from '../selection';
import { usePolling, keepRef } from '../usePolling';
import { api } from '../api';
import { toast, nav, NAV } from '../App';
import type { OpenTab, Group, Settings, ServerStats, TmuxSession } from '../types';
import { ContextMenu, fmtSize, fmtUptime, sockTag, connUser, connScope } from './Overview';
import type { CtxState } from './Overview';
import { confirmDialog } from './Dialog';
import SessionAdmin from './SessionAdmin';
import { IconUser } from '../icons';

const XTERM_THEME = {
  background: '#080b11',
  foreground: '#dfe2f0',
  cursor: '#00f2fe',
  cursorAccent: '#080b11',
  selectionBackground: 'rgba(0, 242, 254, .26)',
  black: '#3d4451', red: '#f2555a', green: '#5fd18c', yellow: '#e0b356',
  blue: '#55a8ff', magenta: '#c678dd', cyan: '#4fc6d8', white: '#c5cdd7',
  brightBlack: '#6a7383', brightRed: '#ff7b7f', brightGreen: '#8ee6a8', brightYellow: '#ffd68a',
  brightBlue: '#79bcff', brightMagenta: '#d99af0', brightCyan: '#7adfeb', brightWhite: '#ffffff'
};

interface Runtime {
  ws: WebSocket | null;
  send: ((d: string) => void) | null;
  reconnect: (() => void) | null;
}

/** 终端画布右键菜单要用的动作 —— 只有 TermPane 拿得到 term 实例，所以由它打包上抛 */
export interface TermMenuActions {
  hasSelection: boolean;
  copy: () => void;
  paste: () => void;
  selectAll: () => void;
  clear: () => void;
  reconnect: () => void;
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}

function TermPane({ tab, visible, active, onActivate, reconnectMax, scrollDefault, exitOnInput, inCopyMode, onStatus, onReady, onWheelUp, onCanvasContextMenu }: {
  tab: OpenTab;
  /** 该终端当前是否落在某个可见格子里 —— 只有可见才需要 fit（隐藏时元素尺寸为 0，fit 会算出 0 列） */
  visible: boolean;
  /** 当前键盘输入目标 —— 只负责抢焦点与高亮，不再管显示与否 */
  active: boolean;
  /** 鼠标点进该终端 → 把它设为输入目标 */
  onActivate: () => void;
  reconnectMax: number;
  scrollDefault: 'view' | 'keys';
  /** 历史模式下打字是否自动退出 copy-mode */
  exitOnInput: boolean;
  /** 该会话当前是否处于 tmux copy-mode（轮询值） */
  inCopyMode: boolean;
  onStatus: (key: string, st: { connected: boolean; exited: boolean; err?: string; retrying?: number }) => void;
  onReady: (key: string, send: ((d: string) => void) | null, reconnect: () => void) => void;
  /** 终端内发生「向上滚轮」时通知外层（发送框也要靠它判断是否需要先退出历史视图） */
  onWheelUp: (key: string) => void;
  /** 在终端画布上右键 → 外层弹自定义菜单 */
  onCanvasContextMenu: (x: number, y: number, act: TermMenuActions) => void;
}) {
  const holder = useRef<HTMLDivElement>(null);
  const rt = useRef<Runtime>({ ws: null, send: null, reconnect: null });
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const attemptsRef = useRef(0);
  const exitedRef = useRef(false);
  /** term 是否已 dispose —— 卸载后迟到的 WS 消息不能再往它写，否则会抛错 */
  const disposedRef = useRef(false);
  const maxRef = useRef(reconnectMax);
  const [gen, setGen] = useState(0); // reconnect generation
  // 键盘退出 copy-mode：只在「查看输出」+ 开关打开时生效
  const escRef = useRef(exitOnInput && scrollDefault === 'view');
  const modeRef = useRef(inCopyMode);
  const wheelUpAt = useRef(0);
  /**
   * 每帧输出解析完后要跑的钩子（selection bridge 用来复查「tmux 是不是又把鼠标上报打开了」）。
   * 走 ref 是因为输出回调在另一个 effect 里，拿不到 layout effect 的局部变量。
   */
  const afterOutput = useRef<() => void>(() => {});

  useEffect(() => { maxRef.current = reconnectMax; }, [reconnectMax]);
  useEffect(() => { escRef.current = exitOnInput && scrollDefault === 'view'; }, [exitOnInput, scrollDefault]);
  useEffect(() => { modeRef.current = inCopyMode; }, [inCopyMode]);
  const reconnectNow = () => { attemptsRef.current = 0; exitedRef.current = false; setGen(g => g + 1); };

  useLayoutEffect(() => {
    const el = holder.current;
    if (!el || el.childElementCount > 0) return;
    const term = new Terminal({
      theme: XTERM_THEME, fontFamily: '"JetBrains Mono","SF Mono",Menlo,Consolas,monospace',
      fontSize: 13, lineHeight: 1.25, cursorBlink: true, scrollback: 5000,
      allowProposedApi: true,
      // xterm 的默认值是 isMac —— 也就是 macOS 上右键会把选区改成一个词，
      // 与「右键菜单里复制当前选区」直接打架。关掉，右键只负责开菜单。
      rightClickSelectsWord: false
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    /*
     * WebGL 渲染器。xterm 默认用 DOM 渲染器（每个样式段一个 <span>，逐行操作 DOM），
     * 大流量输出时成本明显；官方 WebGL addon 是纯 JS、无原生编译，不违反本仓库「零原生依赖」约束。
     *
     * 三重保险，任何一步失败都退回 DOM 渲染器，不影响可用性：
     * ① new / loadAddon 抛错 → catch
     * ② 运行期丢失上下文（浏览器同时可持有的 WebGL 上下文有限，约 16 个）→ onContextLoss 里 dispose，
     *    之后**不再重试**（重试只会反复抢上下文，反而拖垮其它终端）
     * ③ 组件卸载 → 显式 dispose，释放上下文
     */
    let webgl: WebglAddon | null = null;
    try {
      webgl = new WebglAddon();
      webgl.onContextLoss(() => { try { webgl?.dispose(); } catch { /* noop */ } webgl = null; });
      term.loadAddon(webgl);
    } catch {
      try { webgl?.dispose(); } catch { /* noop */ }
      webgl = null;
    }
    disposedRef.current = false;
    /*
     * 终端里的 URL 可点击（实现与取舍见 ../links.ts）。
     * 注意这是 buffer 行级的 link provider —— 只在鼠标移到某一行时才按需扫描那一行，
     * 不参与输出热路径，对 AGENTS.md §1 的开销基线没有影响。
     */
    const links = attachLinks(term);
    /*
     * 拖动选中 + 选中即复制。
     * tmux 开着 mouse on 时 xterm 会把选择服务整个停掉（详见 ../selection.ts 头注释），
     * 这里让前端「看不见」那条上报指令，把拖动还给本地选择；滚轮由它自己转发给 tmux。
     */
    const sel = installSelectionBridge({
      term,
      getSend: () => rt.current.send,
      // 滚轮序列现在由 selection bridge 直接发出去，不再经过 term.onData ——
      // 所以「刚滚过 2 秒内打字自动退出 copy-mode」的时间戳要在这里补记，
      // 否则 escRef 那段乐观判断会永远读到 0，打了字也退不出历史视图。
      onWheelUp: () => { wheelUpAt.current = Date.now(); onWheelUp(tab.key); }
    });
    afterOutput.current = sel.afterOutput;
    /*
     * 自托管字体是可变字体、按需加载。DOM 渲染器下字体迟到会由 CSS 回流自愈；
     * WebGL 渲染器是把字形**栅格化进 atlas**，若在字体就绪前测出的是回退字体的 cell 宽度，
     * atlas 里就会是回退字形且不会自动重建（表现成一次「等宽字体错位」）。
     * 所以字体就绪后主动清一次 atlas。字体本来就在 index.html 里 preload，通常已经命中，
     * 这里是冷缓存 + 快速进终端页那条路的兜底。
     */
    void document.fonts?.ready.then(() => {
      if (disposedRef.current) return;
      try { term.clearTextureAtlas(); } catch { /* noop */ }
    }).catch(() => { /* noop */ });

    term.onData(d => {
      const isMouse = d.startsWith('\x1b[<');
      if (isMouse) {
        // SGR 鼠标序列：button 64 = 滚轮上。记录时间用于「刚滚过」的乐观判断
        if (/^\x1b\[<64;/.test(d)) { wheelUpAt.current = Date.now(); onWheelUp(tab.key); }
      } else if (d && escRef.current) {
        // copy-mode 会吞键盘：先补一个 q 退出历史视图，再发真实按键
        const fresh = Date.now() - wheelUpAt.current < 2000;
        if (modeRef.current || fresh) {
          rt.current.send?.('q');
          wheelUpAt.current = 0;
          modeRef.current = false;
        }
      }
      rt.current.send?.(d);
    });
    term.onResize(({ cols, rows }) => rt.current.ws?.send(JSON.stringify({ t: 'r', c: cols, r: rows })));

    /*
     * 卸载时必须显式 dispose。
     * 原先这里没有 cleanup —— 关掉一个终端标签时组件卸载了，但 xterm 实例仍被它内部的
     * 定时器（光标闪烁 / 渲染刷新）引用着，既回收不掉也还在跑，等于**每开关一次标签泄漏一个实例**。
     */
    return () => {
      disposedRef.current = true;
      // 顺序：先放 addon（它注册的 toDisposable 会把渲染器切回 DOM，那时 term 还得活着），
      // 再 dispose term。xterm 的 Disposable 靠清空内部数组实现幂等，重复调用是 no-op。
      try { sel.dispose(); } catch { /* noop */ }
      try { links.dispose(); } catch { /* noop */ }
      try { webgl?.dispose(); } catch { /* noop */ }
      try { term.dispose(); } catch { /* noop */ }
      termRef.current = null;
      fitRef.current = null;
    };
  }, []);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    let closed = false;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const cols = term.cols || 120, rows = term.rows || 32;
    // bin=1 = 声明本前端能收二进制帧（服务端据此走「合并 + 二进制」的新输出通道）。
    // 不带这个参数的老前端仍然拿到 base64 文本帧，新旧组合都能用。
    let url = `${proto}://${location.host}/ws/terminal?serverId=${tab.serverId}&mode=${tab.mode}&cols=${cols}&rows=${rows}&bin=1`;
    if (tab.session) {
      url += `&session=${encodeURIComponent(tab.session)}&scroll=${scrollDefault}`;
      if (tab.socket) url += `&socket=${encodeURIComponent(tab.socket)}`;
    }
    term.reset();
    term.write('\x1b[90m—— 连接中… ——\x1b[0m\r\n');
    const ws = new WebSocket(url);
    rt.current.ws = ws;
    // 服务端把终端输出作为**二进制帧**发（合并后直发 Buffer，省掉 base64 的 +33% 体积
    // 与浏览器侧逐字节解码）。控制消息仍是文本帧 JSON。
    //
    // ⚠️ 这一行是契约，不能删：默认的 binaryType 是 'blob'，而 `new Uint8Array(blob)`
    // **不报错、静默产生长度 0 的数组** —— 终端会整屏空白且看不出任何异常。
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      // 守卫放在每一处回调上（不只是 onmessage）：卸载后迟到的 onopen 会把闭包写进
      // 父组件的 sendRef / reconnectRef，留下指向已关闭连接的引用。
      if (closed || disposedRef.current) { try { ws.close(); } catch { /* noop */ } return; }
      const sendFn = (d: string) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'i', d })); };
      rt.current.send = sendFn;
      attemptsRef.current = 0;
      exitedRef.current = false;
      onReady(tab.key, sendFn, reconnectNow);
      onStatus(tab.key, { connected: true, exited: false });
    };
    ws.onmessage = ev => {
      if (closed || disposedRef.current) return;
      const raw = ev.data;
      // 二进制帧 = 终端输出，直接喂给 xterm（它接受 Uint8Array，会按 UTF-8 增量解码）
      if (typeof raw !== 'string') {
        // 回调写在 write 的 cb 里：write 是异步解析，紧接着读 modes 会读到旧值
        try { term.write(new Uint8Array(raw as ArrayBuffer), afterOutput.current); } catch { /* noop */ }
        return;
      }
      // 文本帧 = 控制消息。保留旧版 `{t:'d'}` 的 base64 分支：
      // 部署时前后端可能瞬时不一致（先覆盖源码再 restart），这样中途不会瞎掉。
      let m: any;
      try { m = JSON.parse(raw); } catch { return; }
      if (m.t === 'd') {
        term.write(b64ToBytes(m.d), afterOutput.current);
      } else if (m.t === 'x') {
        exitedRef.current = true;
        term.write('\r\n\x1b[90m—— 会话已退出 ——\x1b[0m\r\n', afterOutput.current);
        onStatus(tab.key, { connected: false, exited: true });
      } else if (m.t === 'err') {
        toast(m.d, true);
      }
    };
    ws.onclose = () => {
      rt.current.send = null;
      onReady(tab.key, null, reconnectNow);
      if (closed || disposedRef.current || exitedRef.current) return;
      const max = maxRef.current;
      if (attemptsRef.current < max) {
        attemptsRef.current += 1;
        term.write(`\x1b[90m—— 连接断开，自动重连中 (${attemptsRef.current}/${max}) ——\x1b[0m\r\n`);
        onStatus(tab.key, { connected: false, exited: false, err: `连接断开 · 自动重连中 (${attemptsRef.current}/${max})`, retrying: attemptsRef.current });
        setTimeout(() => { if (!closed) setGen(g => g + 1); }, 1000 + attemptsRef.current * 600);
      } else {
        term.write('\x1b[90m—— 已停止自动重连 ——\x1b[0m\r\n');
        onStatus(tab.key, { connected: false, exited: true, err: `自动重连 ${max} 次失败，请检查网络后手动重连` });
      }
    };
    rt.current.reconnect = reconnectNow;

    const onWinResize = () => { try { fitRef.current?.fit(); } catch { /* noop */ } };
    window.addEventListener('resize', onWinResize);
    return () => {
      closed = true;
      window.removeEventListener('resize', onWinResize);
      onReady(tab.key, null, () => {});
      try { ws.close(); } catch { /* noop */ }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gen, tab.key]);

  // 尺寸自适应交给 ResizeObserver：分屏切换、rail 折叠、窗口缩放都会改容器尺寸。
  // 注意 fit() 只能作用在**有实际尺寸**的元素上 —— 隐藏中（display:none）跳过，
  // 否则会按 0 宽算出 0 列，把 tmux 的窗口尺寸也带坏。
  useEffect(() => {
    const el = holder.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(entries => {
      const r = entries[entries.length - 1]?.contentRect;
      if (!r || r.width < 40 || r.height < 30) return;
      try { fitRef.current?.fit(); } catch { /* noop */ }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 变为可见时补一次 fit（用 rAF 等布局落定）
  useEffect(() => {
    if (!visible) return;
    const id = requestAnimationFrame(() => { try { fitRef.current?.fit(); } catch { /* noop */ } });
    return () => cancelAnimationFrame(id);
  }, [visible]);

  useEffect(() => {
    if (active) { try { termRef.current?.focus(); } catch { /* noop */ } }
  }, [active]);

  // 只读模式挂 term-locked：让「输入被禁用」有视觉表达 —— 原先只有信息栏一行小字，
  // 用户对着终端敲键盘没反应时分不清是只读还是卡死。（样式见 styles.css 的 .term-pane.term-locked）
  // onMouseDownCapture 而不是 onClick：xterm 内部会吃掉点击事件，capture 阶段才抢得到。
  return (
    <div className={`term-pane ${active ? 'active' : ''}${tab.mode === 'readonly' ? ' term-locked' : ''}`}
      onMouseDownCapture={onActivate}
      /*
       * 右键：拦掉浏览器原生菜单，交给应用自己的 ContextMenu。
       * xterm 自己也会监听 contextmenu（把 textarea 挪到鼠标下，方便 Cmd+V 粘到正确位置），
       * 但它不 preventDefault —— 所以这里必须自己拦。
       */
      onContextMenu={e => {
        e.preventDefault();
        e.stopPropagation();
        const term = termRef.current;
        if (!term) return;
        onCanvasContextMenu(e.clientX, e.clientY, {
          hasSelection: term.hasSelection(),
          copy: () => {
            const n = copyTermSelection(term);
            toast(n ? `已复制 ${n} 个字符` : '没有选中内容', !n);
          },
          paste: () => {
            // 非安全上下文（内网 http）下 navigator.clipboard 根本不存在
            const cb = navigator.clipboard;
            if (!cb || !cb.readText) { toast('浏览器不允许脚本读剪贴板，请用 Cmd+V 粘贴', true); return; }
            void cb.readText()
              .then(t => { if (t) rt.current.send?.(t); })
              .catch(() => toast('读取剪贴板被拒绝，请用 Cmd+V 粘贴', true));
          },
          selectAll: () => term.selectAll(),
          // Ctrl+L：让 shell/tmux 自己清屏。直接 term.clear() 只是把前端画布抹掉，
          // 下一次输出或 resize 会把内容又刷回来，看起来像没生效。
          clear: () => rt.current.send?.('\x0c'),
          reconnect: () => reconnectNow()
        });
      }}>
      <div ref={holder} style={{ width: '100%', height: '100%' }} />
    </div>
  );
}

const KEYS: { label: string; data: string }[] = [
  { label: 'Esc', data: '\x1b' }, { label: 'Tab', data: '\t' }, { label: '⇧Tab', data: '\x1b[Z' },
  { label: '^C', data: '\x03' }, { label: '^D', data: '\x04' }, { label: '^Z', data: '\x1a' },
  { label: '↑', data: '\x1b[A' }, { label: '↓', data: '\x1b[B' }, { label: '←', data: '\x1b[D' }, { label: '→', data: '\x1b[C' },
  { label: '⏎', data: '\r' }, { label: 'y', data: 'y' }, { label: 'n', data: 'n' }
];
const MOBILE_KEYS = [
  { label: 'PgUp', data: '\x1b[5~' }, { label: 'PgDn', data: '\x1b[6~' }
];

/** 分屏布局：把终端区切成 1 / 2 / 4 个格子 */
type Layout = 1 | 2 | 4;
const LAYOUTS: { n: Layout; label: string; hint: string }[] = [
  { n: 1, label: '单屏', hint: '整屏一个终端（切回单屏不会断开其它会话）' },
  { n: 2, label: '双屏', hint: '左右两个格子' },
  { n: 4, label: '四分屏', hint: '2×2 四个格子' },
];

export default function TerminalView({ params }: { params: URLSearchParams }) {
  const [tabs, setTabs] = useState<OpenTab[]>([]);
  const [activeKey, setActiveKey] = useState('');
  // ---- 分屏 ----
  // `tabs` 是**已打开的终端连接池**（每个一条 WebSocket），`slots` 只决定「哪个格子显示哪个」。
  // 特意分成两层：切出视野的终端**不断连、不丢历史**，它只是不在格子里而已。
  const [layout, setLayout] = useState<Layout>(() => {
    const v = Number(localStorage.getItem('tw-layout'));
    return v === 2 || v === 4 ? (v as Layout) : 1;
  });
  /** 每个格子挂一个 tab key，'' 表示该格还没选会话 */
  const [slots, setSlots] = useState<string[]>(['']);
  /** 正在为哪个格子挑会话（null = 走「选择会话」大弹窗） */
  const [pickSlot, setPickSlot] = useState<number | null>(null);
  const [status, setStatus] = useState<Record<string, { connected: boolean; exited: boolean; err?: string; retrying?: number }>>({});
  const [pick, setPick] = useState(false);
  const [groups, setGroups] = useState<Group[]>([]);
  // 「新建会话」入口搬到终端页（AGENTS.md §10-3）：
  // 这个入口原先只存在于会话总览页，而终端页侧栏只有「+ SSH 直连」（临时 shell，不是持久会话），
  // 于是 op_logs 里 session_create 长期 0 条 —— 是入口可见性问题，不是没需求。
  const [newSess, setNewSess] = useState<{ serverId: number; serverName: string; name: string } | null>(null);
  const [creating, setCreating] = useState(false);

  const createSess = async () => {
    if (!newSess) return;
    const nm = newSess.name.trim();
    if (!nm) { toast('请填会话名', true); return; }
    setCreating(true);
    try {
      await api.createSession(newSess.serverId, nm);
      toast(`已创建会话 ${nm}`);
      setNewSess(null);
      refreshGroups();
    } catch (e: any) {
      toast(e.message || '创建会话失败', true);
    } finally { setCreating(false); }
  };
  const [settings, setSettings] = useState<Settings | null>(null);
  const [winList, setWinList] = useState<{ index: number; name: string; active: number }[]>([]);
  const [draft, setDraft] = useState('');
  /**
   * 底部输入区是否展开。
   * **默认收起** —— 键盘优先给终端（点终端就能逐键输入，`/` 补全、退格、方向键都正常），
   * 输入区只负责多行文本与批量执行命令。
   */
  const [expanded, setExpanded] = useState(false);
  /** 首次进入终端时的一次性提示：很多人不知道可以点终端直接打字 */
  const [showTip, setShowTip] = useState(() => !localStorage.getItem('tw-term-tip-seen'));
  const draftRef = useRef<HTMLTextAreaElement>(null);
  const [quickCmds, setQuickCmds] = useState<string[]>([]);
  const [ctx, setCtx] = useState<CtxState | null>(null);
  /** 会话管理面板的目标。用「服务器 + 会话对象」定位 —— 同名会话可能在不同 socket 上并存 */
  const [admin, setAdmin] = useState<{ g: Group; s: TmuxSession } | null>(null);
  const [railOpen, setRailOpen] = useState(() => localStorage.getItem('tw-rail') !== '0');
  const [srvStats, setSrvStats] = useState<ServerStats | null>(null);
  const [srvLive, setSrvLive] = useState<{ state: string; latency: number | null }>({ state: 'offline', latency: null });
  // 节点卡片折叠态（默认展开）+ 每台服务器的概览数据
  const [folded, setFolded] = useState<Record<number, boolean>>(() => {
    try { return JSON.parse(localStorage.getItem('tw-rail-fold') || '{}'); } catch { return {}; }
  });
  const [nodeStats, setNodeStats] = useState<Record<number, { stats: ServerStats | null; state: string; loaded: boolean }>>({});
  const sendRef = useRef<Record<string, ((d: string) => void) | null>>({});
  const reconnectRef = useRef<Record<string, (() => void) | null>>({});
  const lastQuery = useRef('');

  /** 把某个 tab 设为输入目标；若它还没落在任何格子里，就顺手放进来（点标签条 = 想看它） */
  const revealTab = useCallback((key: string) => {
    setActiveKey(key);
    setSlots(prev => {
      if (prev.includes(key)) return prev;
      const empty = prev.indexOf('');
      const n = [...prev];
      // 有空位就填空位；格子满了就替换最后一格（否则用户点了标签却看不到东西）
      n[empty >= 0 ? empty : n.length - 1] = key;
      return n;
    });
  }, []);

  /** slotIndex 用于「为某个指定的空格子选会话」；不传则自动找空位 */
  const openTab = useCallback((t: Omit<OpenTab, 'key' | 'uid'>, slotIndex?: number) => {
    // 会话按 socket 隔离，同名会话可能并存 —— key 必须带上 socket
    const key = `${t.serverId}:${t.socket || 'default'}:${t.session || 'shell'}:${t.mode}`;
    // uid 与 key 分离：会话重命名后 key 会变，但 uid 不变，React 不会重挂载终端
    setTabs(ts => (ts.some(x => x.key === key) ? ts : [...ts, { ...t, key, uid: Math.random().toString(36).slice(2, 10) }]));
    if (slotIndex != null) {
      setSlots(prev => { const n = [...prev]; n[slotIndex] = key; return n; });
      setActiveKey(key);
    } else {
      revealTab(key);
    }
  }, [revealTab]);

  useEffect(() => { localStorage.setItem('tw-layout', String(layout)); }, [layout]);

  // 布局切换：把 slots 长度对齐到格子数；变多时顺手把「还没显示的 tab」补进新格子
  useEffect(() => {
    setSlots(prev => {
      if (prev.length === layout) return prev;
      const next = prev.slice(0, layout);
      while (next.length < layout) next.push('');
      if (layout > prev.length) {
        const shown = new Set(next.filter(Boolean));
        for (const t of tabs) {
          if (shown.has(t.key)) continue;
          const i = next.indexOf('');
          if (i < 0) break;
          next[i] = t.key;
          shown.add(t.key);
        }
      }
      return next;
    });
  }, [layout, tabs]);

  // 关掉标签（或被 switchMode 顶掉）后，把还指着它的格子清空 —— 否则那个格子会一直空挂着死 key
  useEffect(() => {
    setSlots(prev => {
      const next = prev.map(k => (k && tabs.some(t => t.key === k) ? k : ''));
      return next.some((k, i) => k !== prev[i]) ? next : prev;
    });
  }, [tabs]);

  // open from query params once
  useEffect(() => {
    const qs = params.toString();
    if (!params.get('server') || lastQuery.current === qs) return;
    lastQuery.current = qs;
    const serverId = Number(params.get('server'));
    const session = params.get('session');
    const mode = (params.get('mode') || 'attach') as OpenTab['mode'];
    const socket = params.get('socket') || null;
    api.servers().then(({ servers }) => {
      const s = servers.find(x => x.id === serverId);
      openTab({ serverId, serverName: s?.name || `#${serverId}`, session, mode, socket });
      history.replaceState(null, '', '#/terminal');
    }).catch(() => {});
  }, [params, openTab]);

  useEffect(() => { api.settings().then(s => { setSettings(s); setQuickCmds(s.quickCommands || []); }).catch(() => {}); }, []);
  useEffect(() => { localStorage.setItem('tw-rail', railOpen ? '1' : '0'); }, [railOpen]);

  // 侧栏：服务器与会话树（5s 轮询）
  usePolling(alive => {
    void api.sessions().then(r => { if (alive()) setGroups(prev => keepRef(prev, r.groups)); }).catch(() => {});
  }, 5000, []);

  useEffect(() => { localStorage.setItem('tw-rail-fold', JSON.stringify(folded)); }, [folded]);

  // 节点概览：只给「已展开」的服务器拉数据，折叠的不发请求
  const expandedKey = groups.filter(g => !folded[g.serverId]).map(g => g.serverId).sort((a, b) => a - b).join(',');
  usePolling(alive => {
    const ids = expandedKey ? expandedKey.split(',').map(Number) : [];
    if (ids.length === 0) return;
    void Promise.all(ids.map(async id => {
      try {
        const r = await api.serverStats(id);
        if (!alive()) return; // 节点被折叠 / 展开集合变了，旧响应不要写回
        setNodeStats(prev => ({ ...prev, [id]: { stats: r.stats, state: r.state, loaded: true } }));
      } catch {
        if (!alive()) return;
        setNodeStats(prev => ({ ...prev, [id]: { stats: null, state: 'offline', loaded: true } }));
      }
    }));
  }, 8000, [expandedKey]);

  // 信息栏：当前活动终端所在服务器的资源与延迟
  const activeServerId = tabs.find(t => t.key === activeKey)?.serverId;
  usePolling(alive => {
    if (!activeServerId) return; // 没有活动终端时下面那条 effect 负责清空，这里不重复 setState
    void api.serverStats(activeServerId).then(r => {
      if (!alive()) return; // 切了标签页 / 换了活动终端，旧响应不要写回
      setSrvStats(r.stats);
      setSrvLive({ state: r.state, latency: r.latency });
    }).catch(() => { /* noop */ });
  }, 5000, [activeServerId]);
  // 失去活动终端时把信息栏清回「离线」，保持原语义
  useEffect(() => {
    if (!activeServerId) { setSrvStats(null); setSrvLive({ state: 'offline', latency: null }); }
  }, [activeServerId]);
  useEffect(() => {
    if (!pick) return;
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') setPick(false); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [pick]);

  const active = tabs.find(t => t.key === activeKey);

  // 会话级的滚轮状态（来自 /api/sessions 轮询）：mouse 为显式值，inMode 表示正处于 copy-mode
  const sessOf = (t?: OpenTab) =>
    t?.session
      ? groups.find(g => g.serverId === t.serverId)?.sessions
          .find(s => s.name === t.session && (s.socket || null) === (t.socket || null))
      : undefined;
  const activeSess = sessOf(active);
  /** 当前标签所在服务器的分组信息（用于展示「以哪个用户连接」） */
  const activeGroup = groups.find(g => g.serverId === active?.serverId);
  /** 标签上的 socket 归属标记（同名会话可能在不同 socket 上并存，必须能区分） */
  const tabSock = (t: OpenTab) => { const s = sessOf(t); return s ? sockTag(s) : null; };
  const scrollMode: 'view' | 'keys' = activeSess?.mouse
    ? (activeSess.mouse === 'on' ? 'view' : 'keys')
    : (settings?.scrollDefault ?? 'view');

  const switchScroll = async (mode: 'view' | 'keys') => {
    if (!active?.session) return;
    try {
      await api.setScroll(active.serverId, active.session, mode, active.socket);
      const r = await api.sessions();
      setGroups(r.groups);
      toast(mode === 'view' ? '滚轮 = 查看输出内容（由 tmux 接管）' : '滚轮 = 历史输入（↑↓ 送进窗格）');
    } catch (e: any) { toast(e.message, true); }
  };

  // window tabs of active tmux session
  const winKey = active && active.session && active.mode !== 'shell' ? active.key : '';
  useEffect(() => {
    if (!winKey) setWinList([]);
  }, [winKey]);
  usePolling(alive => {
    if (!active || !active.session || active.mode === 'shell') return;
    void api.windows(active.serverId, active.session, active.socket)
      .then(r => { if (alive()) setWinList(r.windows as any); }).catch(() => { /* noop */ });
  }, 5000, [winKey]);

  const send = (d: string) => sendRef.current[activeKey]?.(d);

  // 每个标签页最近一次「终端内向上滚轮」的时间：copy-mode 会吞掉键盘和发送框，
  // 轮询值有延迟，用这个时间戳兜住「刚滚上去就想发指令」的窗口。
  const wheelAt = useRef<Record<string, number>>({});
  const noteWheelUp = useCallback((key: string) => { wheelAt.current[key] = Date.now(); }, []);

  /**
   * 发送前先退出 tmux copy-mode（历史视图），否则按键会被 copy-mode 吞掉。
   * 判据：轮询到的 inMode 为真，或 5 秒内刚在终端里上滚过。
   */
  const sendGuarded = (d: string) => {
    const inHistory = activeSess?.inMode || Date.now() - (wheelAt.current[activeKey] || 0) < 5000;
    if (active?.session && inHistory && (settings?.scrollExitOnInput ?? true)) {
      send('q');
      wheelAt.current[activeKey] = 0;
    }
    send(d);
  };

  /**
   * 回车与文本之间必须留的间隔（ms）。
   *
   * 原因：AI CLI（Claude Code / Codex 这类 TUI 输入框）会把「同一批到达的
   * 连续字符 + 换行」识别成一次粘贴，于是那次回车只当作粘贴内容里的换行，
   * 不触发提交 —— 表现就是「文本进了对话框，还得再按一次回车」。
   * 把它们拆成两次独立写入、中间留一个极小间隔，回车才会被当成一次真实的按键。
   * 对普通 shell 无副作用（命令在收到 \r 时才执行）。
   */
  const ENTER_GAP_MS = 80;

  /** 把键盘焦点还给当前格子的终端 —— 发送完 / 收起输入区后调用 */
  const focusTerminal = useCallback(() => {
    const el = document.querySelector('.term-slot.active .xterm-helper-textarea') as HTMLElement | null;
    el?.focus();
  }, []);

  const dismissTip = useCallback(() => {
    setShowTip(false);
    try { localStorage.setItem('tw-term-tip-seen', '1'); } catch { /* 隐私模式下写不了，忽略 */ }
  }, []);

  // 计时从「真正看到终端」开始 —— 否则用户在登录页 / 切换页面的时间也会被算进去，
  // 等他打开会话时提示早就过期了（实测：页面加载 12 秒后才打开会话，提示一次都没出现）。
  const hasActiveTab = !!active;
  useEffect(() => {
    if (!showTip || !hasActiveTab) return;
    const t = window.setTimeout(dismissTip, 9000);
    return () => window.clearTimeout(t);
  }, [showTip, dismissTip, hasActiveTab]);

  const toggleCompose = useCallback((next?: boolean) => {
    const v = next ?? !expanded;
    setExpanded(v);
    // 展开 → 聚焦输入框；收起 → 把键盘还给终端
    window.setTimeout(() => (v ? draftRef.current?.focus() : focusTerminal()), 60);
  }, [expanded, focusTerminal]);

  const sendDraft = () => {
    if (!draft) return;
    const text = draft.replace(/\r?\n/g, '\r');

    // 先决定是否需要退出历史视图（只有一次，避免两次发送各补一个 q）
    const inHistory = activeSess?.inMode || Date.now() - (wheelAt.current[activeKey] || 0) < 5000;
    const needExitHistory = !!(active?.session && inHistory && (settings?.scrollExitOnInput ?? true));
    if (needExitHistory) { send('q'); wheelAt.current[activeKey] = 0; }

    send(text);
    // 回车单独发，让它被识别为「确认输入」而不是粘贴内容的一部分
    window.setTimeout(() => send('\r'), ENTER_GAP_MS);
    setDraft('');
    // 发完把键盘交回终端 —— 批量执行之后用户要看的是终端输出
    focusTerminal();
  };

  const switchMode = (mode: 'attach' | 'readonly' | 'exclusive') => {
    if (!active || !active.session) return;
    setTabs(ts => ts.filter(t => t.key !== active.key));
    openTab({ serverId: active.serverId, serverName: active.serverName, session: active.session, mode, socket: active.socket });
  };

  const closeTab = (key: string) => {
    setTabs(ts => {
      const rest = ts.filter(t => t.key !== key);
      if (key === activeKey) setActiveKey(rest.length ? rest[rest.length - 1].key : '');
      return rest;
    });
  };

  const refreshGroups = useCallback(() => {
    api.sessions().then(r => setGroups(r.groups)).catch(() => {});
  }, []);

  /** 标签只存会话名，管理面板需要完整的会话对象（路径 / 窗口数 / socket 归属）——反查一次 */
  const findSess = useCallback((t: OpenTab): { g: Group; s: TmuxSession } | null => {
    const g = groups.find(x => x.serverId === t.serverId);
    if (!g) return null;
    const s = g.sessions.find(x => x.name === t.session && (x.socket || null) === (t.socket || null));
    return s ? { g, s } : null;
  }, [groups]);

  const openSession = (g: Group, s: TmuxSession, mode: OpenTab['mode'], slotIndex?: number) =>
    openTab({ serverId: g.serverId, serverName: g.serverName, session: s.name, mode, socket: s.socket }, slotIndex);

  /** 会话消失后把它对应的标签一并关掉（否则标签会停在「已断开」），并释放它占的格子 */
  const closeTabsFor = useCallback((serverId: number, name: string, socket: string | null) => {
    setTabs(ts => {
      const hit = ts.filter(t => t.serverId === serverId && t.session === name && (t.socket || null) === socket);
      if (!hit.length) return ts;
      const dead = new Set(hit.map(t => t.key));
      const rest = ts.filter(t => !dead.has(t.key));
      setSlots(prev => prev.map(k => (dead.has(k) ? '' : k)));
      setActiveKey(k => (dead.has(k) ? (rest.length ? rest[rest.length - 1].key : '') : k));
      return rest;
    });
  }, []);

  /** 重命名后同步已打开的标签：key 里含会话名，不跟着改会导致后续操作找不到会话。
   *  用函数式 setActiveKey / setSlots 重映射，且 React key 走 uid，所以终端不会重挂载。 */
  const renameTabSession = useCallback((serverId: number, oldName: string, oldSocket: string | null, newName: string) => {
    setTabs(ts => {
      const hit = ts.filter(t => t.serverId === serverId && t.session === oldName && (t.socket || null) === oldSocket);
      if (!hit.length) return ts;
      const remap = new Map<string, string>();
      hit.forEach(t => remap.set(t.key, `${t.serverId}:${t.socket || 'default'}:${newName}:${t.mode}`));
      setSlots(prev => prev.map(k => remap.get(k) ?? k));
      setActiveKey(k => remap.get(k) ?? k);
      return ts.map(t => {
        const nk = remap.get(t.key);
        return nk ? { ...t, key: nk, session: newName } : t;
      });
    });
  }, []);

  /** 终止目标机上的 tmux 会话 —— 与「关闭视图」是两件事，这一步会真的杀掉会话 */
  const killRemote = async (t: OpenTab) => {
    if (!t.session) return;
    const ok = await confirmDialog({
      title: `终止远端会话 ${t.session}`,
      message: `目标机上该会话内的所有进程将被关闭，滚动历史不再保留。\n此操作不可撤销。`
        + `\n\n注意：「关闭视图」只关掉这个终端标签、不碰会话；这里会真的杀掉它。`
        + (t.socket ? `\n\n该会话不在默认 socket 上（${t.socket}），可能属于其它用户或工具。` : ''),
      danger: true, okLabel: '终止会话'
    });
    if (!ok) return;
    try {
      await api.killSession(t.serverId, t.session, t.socket);
      toast(`会话 ${t.session} 已终止`);
      closeTab(t.key);
      refreshGroups();
    } catch (e: any) { toast(e.message, true); }
  };

  const killFromRail = async (g: Group, s: TmuxSession) => {
    const ok = await confirmDialog({
      title: `终止会话 ${s.name}`,
      message: `目标机上该会话内的所有进程将被关闭，滚动历史不再保留。\n此操作不可撤销。`
        + (s.socket ? `\n\n注意：该会话不在默认 socket 上（${s.socket}），可能属于其它用户或工具。` : ''),
      danger: true, okLabel: '终止会话'
    });
    if (!ok) return;
    try {
      await api.killSession(g.serverId, s.name, s.socket);
      toast(`会话 ${s.name} 已终止`);
      closeTabsFor(g.serverId, s.name, s.socket ?? null);
      refreshGroups();
    } catch (e: any) { toast(e.message, true); }
  };

  /** 侧栏会话的右键 / 「⋯」菜单：打开方式 + 会话管理 + 终止 */
  const sessionMenu = (g: Group, s: TmuxSession) => [
    { label: '在新标签打开', fn: () => openSession(g, s, 'attach') },
    { label: '只读打开', fn: () => openSession(g, s, 'readonly') },
    { label: '独占打开', fn: () => openSession(g, s, 'exclusive') },
    { label: '会话管理…（重命名 / 参数 / 窗口）', fn: () => setAdmin({ g, s }) },
    { label: '终止会话', danger: true, fn: () => { void killFromRail(g, s); } }
  ];

  const st = status[activeKey] || { connected: false, exited: false };

  return (
    <>
      <aside className={`side-rail ${railOpen ? 'open' : ''}`}>
        <div className="rail-head">
          {railOpen ? (
            <>
              <a href="#/sessions" className="rail-brand">
                <span className="rail-mark">&gt;_</span>
                <span className="rail-name">tmux 管理台</span>
                <span className="rail-ver">v0.1</span>
              </a>
              <button className="rail-toggle" onClick={() => setRailOpen(false)} title="收起导航">⟨</button>
            </>
          ) : (
            <button className="rail-expand" onClick={() => setRailOpen(true)} title="展开导航" aria-label="展开导航">»</button>
          )}
        </div>

        {railOpen ? (
          <>
            <nav className="rail-nav">
              {NAV.map(n => (
                <a key={n.path} href={`#${n.path}`} className={n.path === '/terminal' ? 'active' : ''} title={n.label}>
                  <span className="ri"><n.Icon size={15} /></span>
                  <span>{n.label}</span>
                </a>
              ))}
            </nav>
            <div className="rail-section">sessions</div>
            <div className="rail-servers">
              {groups.map(g => {
                const isFolded = !!folded[g.serverId];
                const ns = nodeStats[g.serverId];
                const onNode = active?.serverId === g.serverId;
                const memPct = ns?.stats?.mem.total ? Math.round(ns.stats.mem.used / ns.stats.mem.total * 100) : 0;
                return (
                  <div key={g.serverId} className={`rail-node ${isFolded ? 'folded' : ''} ${onNode ? 'has-active' : ''}`}>
                    {/* 第一行：概览（点击展开 / 收起会话列表） */}
                    <button className="rail-node-h"
                      onClick={() => setFolded(f => ({ ...f, [g.serverId]: !f[g.serverId] }))}
                      title={`${g.serverName} · ${g.live.state} · 点击${isFolded ? '展开' : '收起'}会话列表`}>
                      <span className={`dot ${g.live.state}`} />
                      <span className="rn-name">{g.serverName}</span>
                      <span className="rn-cnt">{g.sessions.length}</span>
                      <span className="rail-lat">{g.live.latency != null ? `${g.live.latency}ms` : '—'}</span>
                      <span className="rn-arrow">›</span>
                    </button>

                    {!isFolded && (
                      <div className="rail-node-body">
                        {/* 服务器基础信息 */}
                        <div className="rn-metrics">
                          {ns?.stats ? (
                            <>
                              <span>CPU<b>{ns.stats.cpuPct}%</b></span>
                              <span>内存<b>{memPct}%</b></span>
                              <span>磁盘<b>{ns.stats.disk.pct}%</b></span>
                              {/* 窄栏里只放 1 分钟负载，完整 1/5/15 挂 title */}
                              <span title={`1 / 5 / 15 分钟负载：${ns.stats.load}`}>负载<b>{String(ns.stats.load).split(/\s+/)[0]}</b></span>
                              <span className="wide">运行<b>{fmtUptime(ns.stats.uptimeS)}</b></span>
                              <span className="wide">配置<b>{ns.stats.cores} 核 · {fmtSize(ns.stats.mem.total)}</b></span>
                            </>
                          ) : (
                            <span className="wide" style={{ color: 'var(--dim)' }}>
                              {ns?.loaded ? '服务器离线，无资源数据' : '资源采集中…'}
                            </span>
                          )}
                        </div>

                        {/* 该服务器已启动的会话 —— 非默认 socket 的会话标出来源 */}
                        {g.sessions.map(s => (
                          <div key={`${s.socket || 'default'}:${s.name}`} className="rail-sess-row">
                            <button
                              className={`rail-sess ${onNode && active?.session === s.name && (active?.socket || null) === (s.socket || null) ? 'on' : ''}`}
                              title={s.socket ? `非默认 tmux socket：${s.socket}` : undefined}
                              onClick={() => openSession(g, s, 'attach')}
                              onContextMenu={e => { e.preventDefault(); setCtx({ x: e.clientX, y: e.clientY, items: sessionMenu(g, s) }); }}>
                              <span className="rs-name">{s.name}</span>
                              {sockTag(s) && <span className="rs-sock">{sockTag(s)}</span>}
                            </button>
                            {/* 「⋯」常驻在行尾（默认淡出、hover 变亮）—— 比右键菜单更容易被发现，
                                用户正是「找不到会话管理入口」才无从下手 */}
                            <button className="rs-more" title="会话管理"
                              aria-label={`${s.name} 的会话操作`}
                              onClick={e => {
                                e.stopPropagation();
                                const r = e.currentTarget.getBoundingClientRect();
                                setCtx({ x: Math.max(8, r.right - 210), y: r.bottom + 4, items: sessionMenu(g, s) });
                              }}>⋯</button>
                          </div>
                        ))}
                        {g.sessions.length === 0 && <div className="rn-sess-empty">（无运行中的会话）</div>}
                        <button className="rail-sess shell"
                          onClick={() => openTab({ serverId: g.serverId, serverName: g.serverName, session: null, mode: 'shell' })}>
                          + SSH 直连
                        </button>
                        <button className="rail-sess create"
                          title="在默认 socket 上创建一个持久会话（不是临时 shell）"
                          onClick={() => setNewSess({ serverId: g.serverId, serverName: g.serverName, name: '' })}>
                          + 新建会话
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
              {groups.length === 0 && <div style={{ color: 'var(--dim)', fontSize: 11, padding: '6px 8px' }}>暂无服务器</div>}
            </div>
          </>
        ) : (
          <div className="rail-icons">
            {NAV.map(n => (
              <a key={n.path} href={`#${n.path}`} className={n.path === '/terminal' ? 'active' : ''} title={n.label}>
                <n.Icon size={17} />
              </a>
            ))}
          </div>
        )}
      </aside>

      <div className="term-main">
        <div className="term-tabs">
        <div className="backbtn" onClick={() => nav('/sessions')} title="返回会话总览">←<span className="hide-mobile">&nbsp;返回</span></div>
        {tabs.map(t => (
          <div key={t.uid} className={`term-tab ${t.key === activeKey ? 'active' : ''}`} onClick={() => setActiveKey(t.key)}
            onContextMenu={e => {
              e.preventDefault();
              const hit = findSess(t);
              const items: { label: string; danger?: boolean; fn: () => void }[] = [];
              if (hit) items.push({ label: '会话管理…（重命名 / 参数 / 窗口）', fn: () => setAdmin(hit) });
              // 刻意写明「不影响远端会话」：原先只叫「关闭标签」，很容易被当成删除会话
              items.push({ label: '关闭视图（不影响远端会话）', fn: () => closeTab(t.key) });
              if (t.session) items.push({ label: '终止远端会话', danger: true, fn: () => { void killRemote(t); } });
              setCtx({ x: e.clientX, y: e.clientY, items });
            }}>
            <span className={`dot ${t.mode === 'shell' ? 'shell' : (status[t.key]?.connected ? 'online' : 'offline')}`} />
            {t.serverName} · {t.session || '临时 shell'}{t.mode === 'readonly' ? '（只读）' : t.mode === 'exclusive' ? '（独占）' : ''}
            {tabSock(t) && <span className="tt-sock" title={`非默认 tmux socket：${t.socket}`}>{tabSock(t)}</span>}
            <span className="close" onClick={e => { e.stopPropagation(); closeTab(t.key); }}>×</span>
          </div>
        ))}
        <div className="addtab" onClick={() => setPick(true)} title="打开会话 / 临时 shell">＋</div>
        </div>

        {active && (
          <div className="term-infobar">
            <span className={`dot ${srvLive.state === 'online' ? 'online' : srvLive.state === 'reconnecting' ? 'reconnecting' : 'offline'}`} />
            <span style={{ color: 'var(--text)' }}>{active.serverName}</span>
            <span className="conn-user" title={connScope(activeGroup?.live) || '尚未获取远端身份'}>
              <IconUser size={10} />{connUser(activeGroup || {})}
            </span>
            <span className="sep">│</span>
            <span className={`infobar-chip ${st.connected ? 'ok' : ''}`}>
              <span className={`dot ${st.connected ? 'online' : 'offline'}`} style={{ width: 5, height: 5 }} />
              {st.connected ? '已连接' : st.retrying != null ? `重连中 ${st.retrying}` : '未连接'}
            </span>
            <span className="infobar-chip">
              {active.mode === 'shell' ? 'SSH 直连' : active.mode === 'readonly' ? '只读模式' : active.mode === 'exclusive' ? '独占模式' : '交互模式'}
            </span>
            {active.socket && (
              <span className="infobar-chip" title={`非默认 tmux socket：${active.socket}`}>
                socket · {tabSock(active) || '其它'}
              </span>
            )}
            <span className="sep">│</span>
            <span>延迟 <b>{srvLive.latency != null ? `${srvLive.latency}ms` : '—'}</b></span>
            <span className="sep">│</span>
            {srvLive.state !== 'online' ? (
              <span style={{ color: srvLive.state === 'reconnecting' ? 'var(--amber)' : 'var(--dim)' }}>{srvLive.state === 'reconnecting' ? '重连中…' : '服务器离线'}</span>
            ) : srvStats ? (
              <>
                <span>CPU <b>{srvStats.cpuPct}%</b> <span style={{ color: 'var(--dim)' }}>({srvStats.cores}核)</span></span>
                <span>内存 <b>{srvStats.mem.total ? Math.round(srvStats.mem.used / srvStats.mem.total * 100) : 0}%</b> <span style={{ color: 'var(--dim)' }}>({fmtSize(srvStats.mem.used)}/{fmtSize(srvStats.mem.total)})</span></span>
                <span>磁盘 <b>{srvStats.disk.pct}%</b></span>
                <span className="hide-mobile">负载 <b>{srvStats.load}</b></span>
                <span className="hide-mobile">运行 <b>{fmtUptime(srvStats.uptimeS)}</b></span>
              </>
            ) : (
              <span style={{ color: 'var(--dim)' }}>资源采集中…</span>
            )}
            <span className="sep">│</span>
            <span className="infobar-chip">UTF-8</span>
          </div>
        )}

      {active?.session && (
        <div className="win-tabs">
          {winList.map(w => (
            <span key={w.index} className={`win-tab ${w.active ? 'active' : ''}`}
              onClick={() => send('\x02' + w.index)} title="切换到该窗口（Ctrl-b + 序号）">
              {w.index}:{w.name}
            </span>
          ))}
          {winList.length === 0 && <span className="win-tab">（无窗口信息）</span>}
          <span className="win-tab toolbtn">
            <select className="scroll-sel" value={scrollMode} disabled={!st.connected}
              onChange={e => switchScroll(e.target.value as 'view' | 'keys')}
              title="滚轮行为：查看输出 = tmux 接管滚轮，上滚翻服务端历史；历史输入 = 滚轮被译为 ↑↓ 送进窗格">
              <option value="view">滚轮：查看输出</option>
              <option value="keys">滚轮：历史输入</option>
            </select>
            {activeSess?.inMode && (
              <span className="win-tab mode-hint" title="tmux 正处于历史浏览模式，键盘输入会被吞掉；按 q 或滚回底部退出">
                <span className="dot" style={{ background: 'var(--amber)', width: 5, height: 5 }} />历史视图
              </span>
            )}
            <button className="btn sm ghost" onClick={() => switchMode('attach')}>实时</button>
            <button className="btn sm ghost" onClick={() => switchMode('readonly')}>只读</button>
            <button className="btn sm ghost" onClick={() => switchMode('exclusive')}>独占</button>
            <button className="btn sm ghost" onClick={() => reconnectRef.current[activeKey]?.()}>重连</button>
          </span>
        </div>
      )}

      {!active && (
        <div className="empty" style={{ marginTop: '18vh' }}>
          <div className="big">&gt;_</div>
          尚未打开终端<br />
          <div style={{ display: 'flex', gap: 10, justifyContent: 'center', marginTop: 14 }}>
            <button className="btn primary" onClick={() => setPick(true)}>选择会话</button>
            <button className="btn" onClick={() => nav('/sessions')}>返回会话总览</button>
          </div>
        </div>
      )}

      {active && st.retrying != null && !st.connected && (
        <div className="term-banner">
          <span className="dot reconnecting" /> {st.err}
          <button className="btn sm" onClick={() => reconnectRef.current[activeKey]?.()}>立即重连</button>
        </div>
      )}

      {active && st.retrying == null && st.exited && !st.connected && (
        <div className="term-banner">
          ⚠ {st.err || '连接已结束'}
          <button className="btn sm" onClick={() => reconnectRef.current[activeKey]?.()}>重新连接</button>
        </div>
      )}

      {/* 分屏控制放终端区上方，而不是塞进信息栏 —— 信息栏已经很满，
          挤进去会把延迟 / 资源那几项压变形 */}
      {active && (
        <div className="layout-bar">
          <span className="lb-l">分屏</span>
          <div className="lb-seg">
            {LAYOUTS.map(l => (
              <button key={l.n} className={layout === l.n ? 'on' : ''}
                onClick={() => setLayout(l.n)} title={l.hint}>{l.label}</button>
            ))}
          </div>
          <span className="lb-hint">
            {layout === 1
              ? '切到双屏或四分屏可同时盯多个会话'
              : '点格子 = 切换键盘输入目标 · 每格的会话名可下拉更换'}
          </span>
        </div>
      )}

      <div className="term-body">
        <div className="term-panes" data-layout={layout}>
          {/* 每个 tab 都保持挂载 —— 它各自握着一条 WebSocket，卸载就等于断开连接、丢 scrollback。
              落位靠 grid 的 order：在 slots 里的按格子序号排，不在的一律 display:none。 */}
          {tabs.map(t => {
            const at = slots.indexOf(t.key);
            const stx = status[t.key];
            // React key 用 uid 而非 t.key：会话重命名会改 key，用 key 当 React key 会重挂载终端
            return (
              <div key={t.uid} className={`term-slot ${t.key === activeKey ? 'active' : ''}`}
                style={at < 0 ? { display: 'none' } : { order: at }}>
                {layout > 1 && (
                  <div className="slot-head">
                    <span className={`slot-dot ${stx?.connected ? 'on' : 'off'}`} />
                    <select className="slot-sel" value={t.key} title="这个格子显示哪个会话"
                      onChange={e => {
                        const v = e.target.value;
                        const idx = at >= 0 ? at : 0;
                        if (v === '__pick__') { setPickSlot(idx); setPick(true); return; }
                        setSlots(prev => { const n = [...prev]; n[idx] = v; return n; });
                        setActiveKey(v);
                      }}>
                      <option value={t.key}>{t.serverName} · {t.session || '临时 shell'}</option>
                      {/* 只列出没被别的格子占用的会话 —— 同一个终端不该同时出现在两个格子里 */}
                      {tabs.filter(x => x.key !== t.key && !slots.includes(x.key)).map(x => (
                        <option key={x.key} value={x.key}>{x.serverName} · {x.session || '临时 shell'}</option>
                      ))}
                      <option value="__pick__">选择其它会话…</option>
                    </select>
                    {t.mode === 'readonly' && <span className="slot-tag">只读</span>}
                    {t.mode === 'exclusive' && <span className="slot-tag">独占</span>}
                    {stx?.retrying != null
                      ? <span className="slot-tag warn">重连 {stx.retrying}</span>
                      : !stx?.connected && <span className="slot-tag warn">断开</span>}
                  </div>
                )}
                <TermPane tab={t} visible={at >= 0} active={t.key === activeKey}
                  onActivate={() => setActiveKey(t.key)}
                  reconnectMax={settings?.reconnectMax ?? 3}
                  scrollDefault={settings?.scrollDefault ?? 'view'}
                  exitOnInput={settings?.scrollExitOnInput ?? true}
                  inCopyMode={!!sessOf(t)?.inMode}
                  onStatus={(k, s) => setStatus(prev => ({ ...prev, [k]: s }))}
                  onWheelUp={noteWheelUp}
                  onCanvasContextMenu={(x, y, act) => setCtx({
                    x, y, items: [
                      { label: '复制', disabled: !act.hasSelection, fn: act.copy },
                      { label: '粘贴', fn: act.paste },
                      { label: '全选', fn: act.selectAll },
                      { label: '清屏', fn: act.clear },
                      { label: '重连', fn: act.reconnect },
                      { label: '关闭终端', danger: true, fn: () => closeTab(t.key) }
                    ]
                  })}
                  onReady={(k, sendFn, rec) => { sendRef.current[k] = sendFn; reconnectRef.current[k] = rec; }} />
              </div>
            );
          })}
          {/* 还没选会话的格子 */}
          {slots.map((k, i) => (k === '' ? (
            <div key={`empty-${i}`} className="term-slot empty" style={{ order: i }}>
              {layout > 1 && <div className="slot-head"><span className="slot-name">未选择</span></div>}
              <button className="slot-empty" onClick={() => { setPickSlot(i); setPick(true); }}>
                <span className="se-plus">+</span>
                <span>选择会话</span>
              </button>
            </div>
          ) : null))}
        </div>

        {active && (
          <div className={`compose${active.mode === 'readonly' ? ' locked' : ''}${expanded ? ' open' : ''}`}>
            {/* 收起态只有这一行。键盘默认归终端 —— 需要多行文本或批量执行命令时才展开 */}
            <div className="compose-bar">
              <button className={`compose-toggle${expanded ? ' on' : ''}`} onClick={() => toggleCompose()}
                title={expanded ? '收起输入区，把键盘还给终端' : '展开输入区：多行文本 / 批量执行命令'}>
                <span className="ct-caret">{expanded ? '▾' : '▸'}</span>
                批量输入
              </button>
              <span className="ch-l">
                <span className={`dot ${st.connected ? 'online' : 'offline'}`} style={{ width: 6, height: 6 }} />
                {active.session || '临时 shell'}
              </span>
              <span className="cb-hint">
                {active.mode === 'readonly'
                  ? '只读模式 · 发送不会生效'
                  : expanded
                    ? 'Enter 换行 · ⌘↵ / Ctrl+↵ 发送（逐行回车确认）· Esc 收起'
                    : '终端内可直接敲键盘（支持 / 补全、退格、方向键）；多行文本与批量命令用这里'}
              </span>
            </div>

            {expanded && (
              <>
                <div className="compose-row">
                  <textarea
                    ref={draftRef}
                    value={draft}
                    onChange={e => setDraft(e.target.value)}
                    onKeyDown={e => {
                      // 展开态是「多行编辑」，Enter 留给换行；发送走 ⌘/Ctrl+↵
                      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendDraft(); }
                      else if (e.key === 'Escape') { e.preventDefault(); toggleCompose(false); }
                    }}
                    placeholder="多行文本 / 一串命令…（Enter 换行，⌘↵ 或 Ctrl+↵ 发送；中文输入法可直接使用）"
                    rows={5}
                  />
                  <div className="compose-actions">
                    <button className="btn primary send-btn" onClick={sendDraft} disabled={!draft.trim()}>批量执行 →</button>
                    <button className="btn sm ghost" onClick={() => { setDraft(''); draftRef.current?.focus(); }} disabled={!draft}>清空</button>
                  </div>
                </div>
                <div className="keypad">
                  {KEYS.map(k => (
                    <button key={k.label} className="key" onClick={() => sendGuarded(k.data)}>{k.label}</button>
                  ))}
                  <span className="hide-mobile" style={{ width: 6 }} />
                  {MOBILE_KEYS.map(k => (
                    <button key={k.label} className="key hide-desktop" onClick={() => sendGuarded(k.data)}>{k.label}</button>
                  ))}
                  {quickCmds.slice(0, 3).map(c => (
                    <button key={c} className="key qc" title={`输入常用指令：${c}`} onClick={() => setDraft(d => (d ? d + ' ' : '') + c)}>$ {c}</button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {/* 一次性提示：绝大多数人不知道点终端就能直接打字（以为必须用下面的输入框） */}
        {showTip && active && (
          <div className="term-tip">
            <span className="tt-key">⌨</span>
            <div className="tt-body">
              <b>终端里可以直接敲键盘</b>
              <span>点一下终端区域，按键就实时送进 tmux —— <code>/</code> 命令补全、退格、方向键都正常。</span>
              <span className="tt-sub">多行文本或批量执行命令，用左下角的「批量输入」展开。</span>
            </div>
            <button className="tt-close" onClick={dismissTip}>知道了</button>
          </div>
        )}
      </div>
      </div>

      {pick && (
        <div className="modal-mask" onClick={e => { if (e.target === e.currentTarget) { setPick(false); setPickSlot(null); } }}>
          <div className="modal">
            <div className="modal-h">{pickSlot != null ? `为第 ${pickSlot + 1} 个格子选择会话` : '打开终端'}</div>
            <div className="modal-b">
              {groups.map(g => (
                <div key={g.serverId} style={{ marginBottom: 14 }}>
                  <div className="group-h" style={{ margin: '4px 0 8px' }}>
                    <span className={`dot ${g.live.state}`} />{g.serverName}
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                    <button className="btn sm" onClick={() => { openTab({ serverId: g.serverId, serverName: g.serverName, session: null, mode: 'shell' }, pickSlot ?? undefined); setPick(false); setPickSlot(null); }}>
                      <span className="dot shell" style={{ marginRight: 4 }} />SSH 直连
                    </button>
                    <button className="btn sm" onClick={() => { setPick(false); setPickSlot(null); setNewSess({ serverId: g.serverId, serverName: g.serverName, name: '' }); }}>
                      + 新建会话
                    </button>
                    {g.sessions.map(s => (
                      <button key={`${s.socket || 'default'}:${s.name}`} className="btn sm"
                        title={s.socket ? `非默认 tmux socket：${s.socket}` : undefined}
                        onClick={() => { openTab({ serverId: g.serverId, serverName: g.serverName, session: s.name, mode: 'attach', socket: s.socket }, pickSlot ?? undefined); setPick(false); setPickSlot(null); }}>
                        {s.name} <span style={{ color: 'var(--dim)' }}>· {s.windows}w{sockTag(s) ? ` · ${sockTag(s)}` : ''}</span>
                      </button>
                    ))}
                    {g.sessions.length === 0 && g.live.state !== 'online' && <span className="tag">{g.live.state === 'reconnecting' ? '重连中' : '离线'}</span>}
                    {g.sessions.length === 0 && g.live.state === 'online' && <span className="tag">无会话</span>}
                  </div>
                </div>
              ))}
              {groups.length === 0 && <div className="empty">没有服务器，先去 <a href="#/servers" style={{ color: 'var(--primary)' }}>服务器管理</a> 添加</div>}
            </div>
            <div className="modal-f">
              <span style={{ marginRight: 'auto', color: 'var(--dim)', fontSize: 11.5 }}>
                新建会话请用各节点下的「+ 新建会话」（不再跳转到会话总览页）
              </span>
              <button className="btn primary" onClick={() => { setPick(false); setPickSlot(null); }}>关闭</button>
            </div>
          </div>
        </div>
      )}
      {newSess && (
        <div className="modal-mask" onClick={e => { if (e.target === e.currentTarget) setNewSess(null); }}>
          <div className="modal" style={{ width: 420 }}>
            <div className="modal-h">新建会话 · {newSess.serverName}</div>
            <div className="modal-b">
              <div className="field" style={{ margin: 0 }}>
                <label>会话名</label>
                <input className="mono" autoFocus value={newSess.name} placeholder="例如 work / build-watch"
                  onChange={e => setNewSess({ ...newSess, name: e.target.value })}
                  onKeyDown={e => {
                    if (e.key === 'Enter') void createSess();
                    if (e.key === 'Escape') setNewSess(null);
                  }} />
                <div className="hint">
                  字母数字开头，可含 . _ -，最长 64 字符。建在默认 socket、工作目录为远端 HOME。
                  建好后在左侧点它即可进入。
                </div>
              </div>
            </div>
            <div className="modal-f">
              <button className="btn" onClick={() => setNewSess(null)}>取消</button>
              <button className="btn primary" disabled={creating} onClick={createSess}>创建</button>
            </div>
          </div>
        </div>
      )}
      {ctx && <ContextMenu st={ctx} onClose={() => setCtx(null)} />}

      {admin && (
        <SessionAdmin
          serverId={admin.g.serverId}
          serverName={admin.g.serverName}
          info={admin.s}
          onClose={() => setAdmin(null)}
          onRenamed={newName => {
            // 标签的 key 里含会话名，必须同步 —— 否则后续发送/切换会指向一个已不存在的会话名
            renameTabSession(admin.g.serverId, admin.s.name, admin.s.socket ?? null, newName);
            setAdmin(a => (a ? { ...a, s: { ...a.s, name: newName } } : a));
            refreshGroups();
          }}
          onKilled={() => {
            closeTabsFor(admin.g.serverId, admin.s.name, admin.s.socket ?? null);
            refreshGroups();
          }}
          onChanged={refreshGroups}
        />
      )}
    </>
  );
}
