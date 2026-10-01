/**
 * 小红书笔记下载器 - MAIN world 脚本(运行在页面自身 JS 环境)
 *
 * 唯一职责:读取 window.__INITIAL_STATE__ 中的数据,通过 CustomEvent 回传给
 * 隔离环境的 content script(DOM 事件可以跨越两个世界,字符串 detail 最稳)。
 *
 * 背景:批量下载时,笔记直链需要逐篇的 xsec_token,而 DOM 里的卡片链接不带 token,
 * 只有页面 state(user.notes)里才有。content script 在隔离世界访问不到页面 JS 对象,
 * 所以需要这个桥。注意 state 是 Vue 响应式对象,标量可能包在 ref({value})里,要解包。
 */
(() => {
  'use strict';

  if (window.__xhsDlMainLoaded) return;
  window.__xhsDlMainLoaded = true;

  /** 递归解包 Vue ref(形如 {value: xxx} 的包装对象) */
  function unwrap(x, depth = 0) {
    if (x === null || x === undefined || depth > 6) return x;
    if (typeof x === 'object') {
      if (Array.isArray(x)) return x.map((i) => unwrap(i, depth + 1));
      if ('value' in x && Object.keys(x).length <= 5) return unwrap(x.value, depth + 1);
    }
    return x;
  }

  /**
   * 读取博主主页已加载的笔记列表(滚动加载会持续追加)。
   * 结构为「数组的数组」(按批次分页),每项形如 {id, xsecToken, noteCard: {...}}。
   */
  function readProfileNotes() {
    const batches = unwrap(window.__INITIAL_STATE__?.user?.notes);
    if (!Array.isArray(batches)) return [];
    const flat = [];
    for (const b of batches) {
      if (Array.isArray(b)) flat.push(...b);
      else if (b && typeof b === 'object') flat.push(b);
    }
    const items = [];
    for (const it of flat) {
      if (!it || typeof it !== 'object') continue;
      try {
        const card = it.noteCard && typeof it.noteCard === 'object' ? it.noteCard : {};
        items.push({
          noteId: String(it.id ?? it.noteId ?? it.note_id ?? card.noteId ?? ''),
          xsecToken: String(it.xsecToken ?? it.xsec_token ?? card.xsecToken ?? ''),
          title: String(card.displayTitle ?? card.title ?? it.displayTitle ?? it.title ?? ''),
        });
      } catch (_) {
        // 单条损坏直接跳过,不影响整体
      }
    }
    return items.filter((it) => it.noteId && it.xsecToken);
  }

  document.addEventListener('xhs-dl-request', (event) => {
    let req = null;
    try {
      req = JSON.parse(event.detail);
    } catch (_) {
      return;
    }
    let payload = { reqId: req.reqId, ok: false, data: null };
    if (req.kind === 'profile-notes') {
      try {
        payload = { reqId: req.reqId, ok: true, data: readProfileNotes() };
      } catch (_) {
        // 保持失败默认值
      }
    }
    document.dispatchEvent(new CustomEvent('xhs-dl-response', { detail: JSON.stringify(payload) }));
  });
})();
