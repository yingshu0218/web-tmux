import { useEffect, useRef } from 'react';

/**
 * 统一的「按间隔拉数据」hook —— 替代散落各处的裸 `setInterval`。
 *
 * 单独抽出来的原因（2026-09-30 性能诊断）：
 * 全站原先有 8 处 `setInterval` 轮询，**没有任何一处判断页面是否可见**。
 * 于是把标签页放在后台、或者把它丢在副屏上不管，它照样全速跑 ——
 * 这正是「笔记本一直温温的、风扇偶尔转」最典型的来源。
 *
 * 行为约定：
 * - 页面被隐藏（`document.hidden`：切走标签页 / 最小化）时**跳过**本轮请求
 * - 重新变为可见时**立即补拉一次**，避免回来看到十几秒前的旧数据
 * - `deps` 变化时重建定时器并立即拉一次（与原来的 `useEffect` 语义一致）
 *
 * ## 回调签名
 *
 * `fn` 会收到一个 `alive()`：**effect 还没被清理**时返回 true。
 * 异步响应回来时先 `if (!alive()) return;` 再 setState —— 否则「切换服务器 / 折叠节点」
 * 之后，**在途的旧请求**仍会把已经过期的数据写回去（原实现用 `let stop = false` 挡的就是这个，
 * 重写时不能丢）。
 *
 * ## ⚠️ 使用须知（三条都不报错，但会静默出问题）
 *
 * 1. **`intervalMs` 不参与 `deps`**，但内部已把它补进依赖并钳到 ≥1000ms。
 *    即便如此，调用方仍应把「会影响请求参数的东西」放进 `deps`（如 `[serverId]`），
 *    否则切了目标却还在打旧接口。
 * 2. **不要在 `deps` 里放每次渲染都新建的数组/对象**（如内联 `[a, {}]`）——
 *    定时器会被反复销毁重建，等于没有轮询。
 * 3. 传函数进 `deps` 是没必要的：`fnRef` 保证回调闭包始终是最新的。
 *
 * ⚠️ 边界：`document.hidden` 只在标签页不可见时为 true。
 * **窗口可见但你切到别的应用时它仍是 false**，轮询照跑 —— 这是浏览器 API 的固有限制。
 * 不要在这里改成 `document.hasFocus()`：那会让「把终端摆在副屏盯着看」这种正常用法
 * 变成数据不刷新（终端输出走的是 WebSocket，不受本 hook 影响，但资源/会话列表会陈旧）。
 */
export function usePolling(fn: (alive: () => boolean) => void, intervalMs: number, deps: unknown[] = []) {
  // 下限 1000ms：防 `previewInterval` 之类来自接口/设置的值是 0 或 NaN 时
  // 退化成 `setInterval(fn, 0)`——那会变成每张预览卡每 4ms 打一次后端（每次都是一条 SSH capture-pane）。
  const iv = Math.max(1000, Number(intervalMs) || 0);

  // 用 ref 持有最新回调：这样 deps 里不需要放函数，调用方不必为它套 useCallback
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    let stopped = false;
    // 与原来的 `let stop = false` 同义：effect 清理后，在途响应一律不再写回 state
    const alive = () => !stopped;
    const run = () => { if (!stopped && !document.hidden) fnRef.current(alive); };

    run();
    const timer = setInterval(run, iv);
    const onVisibility = () => { if (!document.hidden) run(); };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
    // deps 数组长度恒定（调用方 + iv 恒定一项），满足 React 对 deps 长度稳定的要求
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, iv]);
}

/**
 * 轮询回来的数据和上一份**完全相同**时，保留旧引用。
 *
 * 配合 `setXxx(prev => keepRef(prev, next))` 使用。
 * 少了这一步，每 5s 一次 `setGroups(全新数组)` 会让所有下游 `memo` 全部失效 ——
 * 「加了 memo 却没效果」最常见的原因就是这个。
 *
 * 比较用 JSON 序列化：数据来自同一条 API 序列化路径，键序稳定，够用且零依赖。
 *
 * ⚠️ **副作用（须知情）**：返回 `prev` 时 React 会跳过重渲染，
 * 而 `relTime()`（「3 秒前」）、「5 分钟内活跃」这类**渲染期现算**的文案就不会更新了。
 * 实际影响被一个心跳兜住：`live.lastCheck` 每次心跳（默认 15s）都会变，
 * 所以数据最多 ~15s 变一次，文案跟着刷新。若将来把心跳关了或拉长，这里要重新评估。
 */
export function keepRef<T>(prev: T, next: T): T {
  try {
    return JSON.stringify(prev) === JSON.stringify(next) ? prev : next;
  } catch {
    return next;
  }
}
