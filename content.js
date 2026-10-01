/**
 * 小红书笔记下载器 - Content Script(隔离环境)
 *
 * 功能:
 *  - 笔记页(/explore/xxx 等):显示「下载此笔记」按钮,下载当前笔记的图片/视频 + 笔记信息
 *  - 博主主页(/user/profile/xxx):显示「下载该博主全部笔记」按钮,自动滚动收集全部笔记后逐篇下载
 *
 * 原理(不依赖需要签名的内部 API):
 *  1. 通过同源 fetch 请求笔记页 HTML(携带登录 Cookie 与 xsec_token)
 *  2. 从 HTML 中的 window.__INITIAL_STATE__ 提取笔记数据(新字段名 noteDetailMap)
 *  3. 批量下载的逐篇 xsec_token 由 main.js(MAIN world)从页面 state 读取回传
 *  4. 图片字节优先由 background 抓取(host_permissions 不受页面跨域限制),
 *     CDN 返回的 webp/avif 转码为 jpg 后与视频一起用 zip.js 打包:xiaohongshu-标题-日期.zip
 *  5. zip 的 blob URL 发给 background.js 落盘,由 onDeterminingFilename 改名到子目录
 *     (Chrome 会忽略跨上下文 blob URL 下载的 filename 参数)
 */
(() => {
  'use strict';

  if (window.__xhsDlLoaded) return;
  window.__xhsDlLoaded = true;

  // ---------- 配置常量 ----------
  const ROOT_DIR = '小红书下载';
  const NOTE_LINK_SELECTOR =
    'a[href*="/explore/"], a[href*="/discovery/item/"], a[href*="/search_result/"]';
  const URL_WATCH_INTERVAL_MS = 400; // 轮询检测 SPA 路由变化
  const SCROLL_WAIT_MS = 1200; // 每次自动滚动后等待加载的时间(实测每批约 1 秒)
  const STALE_ROUNDS_LIMIT = 6; // 连续几轮没有新笔记则认为已到底
  const NOTE_FETCH_INTERVAL_MS = 600; // 两篇笔记之间的基础间隔,避免触发风控
  const MEDIA_GAP_MS = 80; // 单篇笔记内媒体文件之间的抓取间隔
  const LOG_MAX_LINES = 200;
  const MAIN_TIMEOUT_MS = 2000; // 等待 MAIN world 响应的超时

  // ---------- 运行状态 ----------
  const state = { running: false, cancelled: false, openId: null };

  // ---------- UI 引用 ----------
  const ui = {
    root: null,
    btn: null,
    panel: null,
    title: null,
    status: null,
    progress: null,
    bar: null,
    log: null,
    path: null,
    open: null,
    cancel: null,
  };

  // ---------- 基础工具 ----------
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const trunc = (s, n = 24) => (s && s.length > n ? `${s.slice(0, n)}…` : s || '');
  const pad2 = (n) => String(n).padStart(2, '0');
  const pad3 = (n) => String(n).padStart(3, '0');

  /** 元素当前是否真实可见(挂在 display:none 的隐藏布局副本里时为 false) */
  function isVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    return el.offsetParent !== null && rect.width > 0 && rect.height > 0;
  }

  /** 时间戳 → 20260930 形式(本地时区) */
  function fmtYMD(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
  }

  /** 在对象上依次取多个可能的键名(兼容 camelCase / snake_case) */
  function pick(obj, ...keys) {
    if (!obj) return undefined;
    for (const k of keys) {
      const v = obj[k];
      if (v !== undefined && v !== null && v !== '') return v;
    }
    return undefined;
  }

  function sanitizeFilename(name, fallback = '未命名') {
    let s = String(name ?? '')
      .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_') // 文件系统非法字符
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[. ]+$/g, '');
    if (s.length > 60) s = s.slice(0, 60);
    return s || fallback;
  }

  /** CDN 直链带签名,按原样下载最稳,只处理协议相对地址 */
  function normalizeUrl(url) {
    if (url.startsWith('//')) return `https:${url}`;
    return url;
  }

  /** 按魔数判断真实图片格式,识别不了返回 null(XHS 的 CDN 会按内容协商返回 webp,URL 里看不出来) */
  function sniffImageExt(bytes) {
    if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)
      return 'png';
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
    if (
      bytes.length >= 12 &&
      bytes[0] === 0x52 && bytes[1] === 0x49 && // RIFF
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50 // WEBP
    )
      return 'webp';
    if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'gif';
    if (bytes.length >= 12 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
      const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]); // ftyp 品牌位
      if (/^avi/i.test(brand)) return 'avif';
    }
    return null;
  }

  /**
   * 把图片整理成「双击即可打开」的形态:
   * webp/avif 字节存成 .jpg 会导致系统看图软件打不开,统一用 canvas 转码为 JPEG;
   * 转码失败则保留原字节并使用真实扩展名兜底。
   * @param {Uint8Array} data
   * @param {string} contentType 响应 Content-Type
   * @returns {Promise<{ext: string, data: Uint8Array}>}
   */
  async function toOpenableImage(data, contentType) {
    let ext = sniffImageExt(data);
    if (!ext) {
      const m = /image\/(png|webp|avif|gif|jpeg)/i.exec(contentType || '');
      ext = m ? (m[1] === 'jpeg' ? 'jpg' : m[1]) : 'jpg';
    }
    if (ext !== 'webp' && ext !== 'avif') return { ext, data };
    try {
      const bitmap = await createImageBitmap(new Blob([data]));
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff'; // JPEG 不支持透明,先铺白底避免透明区域变黑
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
      if (blob && blob.size) return { ext: 'jpg', data: new Uint8Array(await blob.arrayBuffer()) };
    } catch (_) {
      // 转码失败(如动图解码异常):保留原字节,用真实扩展名兜底
    }
    return { ext, data };
  }

  // ---------- 页面类型识别 ----------
  function getPageType() {
    const p = location.pathname;
    if (/^\/user\/profile\//.test(p)) return 'profile';
    if (/^\/(explore|discovery\/item|search_result)\//.test(p)) return 'note';
    return null;
  }

  function extractNoteId(url) {
    const m = String(url).match(/\/(?:explore|discovery\/item|search_result)\/([0-9a-zA-Z]{16,64})/);
    return m ? m[1] : null;
  }

  // ---------- MAIN world 桥接(读取页面 state) ----------

  const MAIN_REQUEST_EVENT = 'xhs-dl-request';
  const MAIN_RESPONSE_EVENT = 'xhs-dl-response';
  let mainReqSeq = 0;

  /**
   * 调用 main.js 提供的能力。返回 data;超时或失败返回 null。
   * @param {string} kind 请求类型
   */
  function callMainWorld(kind) {
    return new Promise((resolve) => {
      const reqId = `r${Date.now()}_${(mainReqSeq += 1)}`;
      const cleanup = () => {
        clearTimeout(timer);
        document.removeEventListener(MAIN_RESPONSE_EVENT, onResponse);
      };
      const onResponse = (event) => {
        try {
          const payload = JSON.parse(event.detail);
          if (payload.reqId === reqId) {
            cleanup();
            resolve(payload.ok ? payload.data : null);
          }
        } catch (_) {
          // 忽略损坏的事件包
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve(null);
      }, MAIN_TIMEOUT_MS);
      document.addEventListener(MAIN_RESPONSE_EVENT, onResponse);
      document.dispatchEvent(
        new CustomEvent(MAIN_REQUEST_EVENT, { detail: JSON.stringify({ reqId, kind }) })
      );
    });
  }

  // ---------- 解析笔记页 __INITIAL_STATE__ ----------

  /**
   * 用括号配平的方式截取 window.__INITIAL_STATE__ = {...} 的 JSON 字符串。
   * 比正则到 </script> 更稳:不受脚本尾部附带代码影响。
   */
  function extractStateJson(html) {
    const key = 'window.__INITIAL_STATE__';
    const keyIdx = html.indexOf(key);
    if (keyIdx === -1) return null;
    const start = html.indexOf('{', keyIdx);
    if (start === -1) return null;
    let depth = 0;
    let inStr = false;
    let quote = '';
    for (let i = start; i < html.length; i += 1) {
      const c = html[i];
      if (inStr) {
        if (c === quote && html[i - 1] !== '\\') inStr = false;
        continue;
      }
      if (c === '"' || c === "'") {
        inStr = true;
        quote = c;
        continue;
      }
      if (c === '{') depth += 1;
      else if (c === '}') {
        depth -= 1;
        if (depth === 0) return html.slice(start, i + 1);
      }
    }
    return null;
  }

  /**
   * 解析出 state 对象。
   * 页面序列化的 JSON 里可能出现裸 undefined 关键字,需要替换成 null 再 parse。
   */
  function parseNoteState(html) {
    const raw = extractStateJson(html);
    if (!raw) return null;
    const attempts = [
      raw,
      raw.replace(/([{,:\[]\s*)undefined(\s*[,}\]])/g, '$1null$2'),
      raw.replace(/\bundefined\b/g, 'null'),
    ];
    for (const text of attempts) {
      try {
        return JSON.parse(text);
      } catch (_) {
        // 尝试下一种替换策略
      }
    }
    return null;
  }

  function pickImageUrl(img) {
    const infoList = pick(img, 'infoList', 'info_list');
    const raw =
      pick(img, 'urlDefault', 'url_default') ||
      (Array.isArray(infoList) && infoList.length ? infoList[infoList.length - 1].url : undefined);
    return raw ? normalizeUrl(raw) : null;
  }

  function pickVideoUrl(note) {
    const stream = note?.video?.media?.stream || {};
    for (const codec of ['h264', 'h265', 'av1']) {
      const arr = stream[codec];
      const item = Array.isArray(arr) ? arr[0] : null;
      const url = item ? pick(item, 'masterUrl', 'master_url') : null;
      if (url) return { url: normalizeUrl(url), codec };
    }
    return null;
  }

  function normalizeNote(note, noteUrl) {
    const images = [];
    for (const img of note.imageList || []) {
      const url = pickImageUrl(img);
      if (url) images.push({ url });
    }
    const video = pickVideoUrl(note);
    const tagList = pick(note, 'tagList', 'tag_list');
    const user = note.user || {};
    return {
      noteId: String(pick(note, 'noteId', 'note_id') || extractNoteId(noteUrl) || ''),
      title: note.title || '',
      desc: note.desc || '',
      type: note.type || (video ? 'video' : 'normal'),
      author: pick(user, 'nickname', 'nick_name') || '未知博主',
      authorId: pick(user, 'userId', 'user_id') || '',
      time: Number(note.time || 0),
      tags: (Array.isArray(tagList) ? tagList : []).map((t) => t.name).filter(Boolean),
      images,
      video,
      url: noteUrl,
    };
  }

  /**
   * 获取一篇笔记的完整数据(标题/正文/图片/视频)。
   * @param {string} noteUrl 笔记页地址,必须携带 xsec_token(裸链接拿到的是空数据)
   */
  async function fetchNoteData(noteUrl) {
    const res = await fetch(noteUrl, { credentials: 'include' });
    if (!res.ok) throw new Error(`请求失败 HTTP ${res.status}`);
    const html = await res.text();
    const data = parseNoteState(html);
    if (!data) throw new Error('页面数据解析失败(可能未登录或页面结构变化)');

    // 新版字段名是 noteDetailMap,旧版是 noteDataMap,两者都兼容
    const noteMap = data?.note?.noteDetailMap || data?.note?.noteDataMap || {};
    const keys = Object.keys(noteMap);
    if (!keys.length) {
      throw new Error('笔记数据为空(链接可能缺少 xsec_token,请从博主页或推荐流中打开)');
    }
    const noteId = extractNoteId(noteUrl);
    let entry = noteMap[noteId];
    if (!entry?.note) entry = noteMap[keys[0]];
    const note = entry?.note;
    if (!note || (!note.imageList && !note.video)) {
      throw new Error('笔记内容为空(可能已删除、仅自己可见或需要验证)');
    }
    return normalizeNote(note, noteUrl);
  }

  // ---------- 下载(zip 打包) ----------

  /**
   * 抓取媒体文件的字节(强制 https,CDN 签名直链无需 Cookie,实测允许跨域)。
   * @returns {Promise<{data: Uint8Array, contentType: string}>}
   */
  async function fetchBytes(url) {
    const u = url.startsWith('//') ? `https:${url}` : url.replace(/^http:\/\//i, 'https:');
    const resp = await fetch(u, { credentials: 'omit' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const buf = await resp.arrayBuffer();
    if (!buf.byteLength) throw new Error('内容为空');
    return { data: new Uint8Array(buf), contentType: resp.headers.get('content-type') || '' };
  }

  function base64ToBytes(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  /**
   * 抓取图片字节:优先交给 background 的 Service Worker 抓取
   * (配合 host_permissions 不受页面跨域限制,参照「小红书采集助手」的实现),
   * 失败时回退为页面内直接 fetch(CDN 允许跨域)。
   * @returns {Promise<{data: Uint8Array, contentType: string}>}
   */
  async function fetchImageBytes(url) {
    const u = url.startsWith('//') ? `https:${url}` : url.replace(/^http:\/\//i, 'https:');
    try {
      const res = await chrome.runtime.sendMessage({ type: 'fetch-image', url: u });
      if (res && res.ok && typeof res.b64 === 'string') {
        return { data: base64ToBytes(res.b64), contentType: res.contentType || '' };
      }
      throw new Error((res && res.error) || '后台抓取无响应');
    } catch (_) {
      // 回退:页面内直接抓取
      return fetchBytes(u);
    }
  }

  /**
   * 把 zip Blob 保存到指定子路径(如 小红书下载/博主/xiaohongshu-标题-日期.zip),成功返回 downloadId。
   * blob URL 在 content script 创建(SW 里没有 URL.createObjectURL);Chrome 会忽略
   * 这类跨上下文 blob URL 的 filename 参数,由 background 监听
   * downloads.onDeterminingFilename 统一改名为目标子路径。
   * 失败时降级为页面锚点下载(不支持子目录,仅保留 zip 文件名)。
   */
  async function saveZip(blob, savePath) {
    const blobUrl = URL.createObjectURL(blob);
    try {
      const res = await chrome.runtime.sendMessage({ type: 'download', url: blobUrl, filename: savePath });
      if (res && res.ok && typeof res.downloadId === 'number') return res.downloadId;
      throw new Error((res && res.error) || '下载失败');
    } catch (e) {
      // 兜底:页面锚点直接下载(zip 文件名保留,但落在默认下载目录、不支持子目录)
      try {
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = savePath.split('/').pop();
        document.body.appendChild(a);
        a.click();
        a.remove();
      } catch (_) {
        // 锚点兜底也失败则抛出原始错误
      }
      throw new Error(`${e.message}(已尝试浏览器直接下载,请检查下载栏)`);
    } finally {
      // 延迟回收,确保下载器读完数据
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
    }
  }

  /**
   * 生成笔记 markdown,图片/视频按实际保存路径相对引用。
   * @param {object} n fetchNoteData 的返回值
   * @param {Array<{path: string}>} imgEntries 已抓取的图片条目
   * @param {{path: string}|null} videoEntry 视频条目
   */
  function buildMarkdown(n, imgEntries, videoEntry) {
    const date = n.time ? new Date(n.time).toLocaleString('zh-CN', { hour12: false }) : '';
    const lines = [];
    lines.push(`# ${n.title || '无标题'}`, '');
    lines.push(`- 博主:${n.author}${n.authorId ? `(ID: ${n.authorId})` : ''}`);
    if (date) lines.push(`- 发布时间:${date}`);
    lines.push(`- 链接:${n.url}`);
    if (n.tags.length) lines.push(`- 标签:${n.tags.map((t) => `#${t}`).join(' ')}`);
    lines.push('', '## 正文', '', n.desc || '(无正文)', '');
    if (imgEntries.length || videoEntry) {
      lines.push('## 媒体', '');
      imgEntries.forEach((e, i) => lines.push(`![${n.video && i === 0 ? '封面' : `图片${i + 1}`}](images/${e.path})`));
      if (videoEntry) lines.push('', `[视频](video.mp4)`);
    }
    lines.push('', `> 由「小红书笔记下载器」导出于 ${new Date().toLocaleString('zh-CN', { hour12: false })}`);
    return lines.join('\n');
  }

  /**
   * 打包并下载一篇笔记:xiaohongshu-标题-日期.zip(内含 markdown + images/ + video.mp4)。
   * @param {object} note fetchNoteData 的返回值
   * @param {number|null} index 批量下载时的序号;单篇下载传 null
   * @returns {{errors: string[], downloadId: number|null}} 失败项列表与下载任务 ID
   */
  async function downloadNote(note, index) {
    const date = fmtYMD(note.time || Date.now()); // 发布日期,缺失时用当天
    const title = sanitizeFilename(note.title || note.noteId);
    const zipName = `xiaohongshu-${title}-${date}.zip`;
    const prefix = index ? `${pad3(index)}_` : '';
    const savePath = `${ROOT_DIR}/${sanitizeFilename(note.author)}/${prefix}${zipName}`;
    const errors = [];

    // 1) 抓取图片字节(优先经 background 抓取;webp/avif 自动转码为 jpg,保证双击可打开)
    const imgEntries = [];
    let i = 0;
    for (const img of note.images) {
      if (state.cancelled) return errors;
      i += 1;
      try {
        const { data, contentType } = await fetchImageBytes(img.url);
        const file = await toOpenableImage(data, contentType);
        const name = note.video && i === 1 ? `cover.${file.ext}` : `${pad2(i)}.${file.ext}`;
        imgEntries.push({ path: name, data: file.data });
      } catch (e) {
        errors.push(`图${i}(${e.message})`);
      }
      await sleep(MEDIA_GAP_MS);
    }

    // 2) 抓取视频字节(视频笔记)
    let videoEntry = null;
    if (note.video && !state.cancelled) {
      try {
        videoEntry = { path: 'video.mp4', data: (await fetchBytes(note.video.url)).data };
      } catch (e) {
        errors.push(`视频(${e.message})`);
      }
    }
    if (state.cancelled) return errors;

    // 3) 组装 zip 条目:markdown 引用 images/ 与 video.mp4 的实际文件名
    const files = [
      { name: `${title}.md`, data: new TextEncoder().encode(buildMarkdown(note, imgEntries, videoEntry)) },
      ...imgEntries.map((e) => ({ name: `images/${e.path}`, data: e.data })),
    ];
    if (videoEntry) files.push(videoEntry);

    // 4) 打包下载(background 通过 onDeterminingFilename 落到「小红书下载/博主/」子目录)
    let downloadId = null;
    try {
      downloadId = await saveZip(XhsZip.buildZip(files), savePath);
    } catch (e) {
      errors.push(`zip 保存(${e.message})`);
    }
    return { errors, downloadId };
  }

  // ---------- 收集博主全部笔记(带 xsec_token) ----------

  /** 按 noteId 去重 */
  function dedupeById(items) {
    const seen = new Set();
    return items.filter((it) => {
      if (seen.has(it.noteId)) return false;
      seen.add(it.noteId);
      return true;
    });
  }

  /** 从笔记卡片向上找到真正可滚动的容器(部分页面滚动发生在内部 div 上) */
  function findScrollContainer() {
    let el = document.querySelector(NOTE_LINK_SELECTOR);
    while (el && el !== document.documentElement) {
      const st = getComputedStyle(el);
      if (/(auto|scroll)/.test(st.overflowY) && el.scrollHeight > el.clientHeight + 10) return el;
      el = el.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  /**
   * 自动滚动页面到底,通过 main.js 从页面 state 读取已加载的笔记(含 xsec_token)。
   * @returns {Promise<Array<{noteId, xsecToken, title}>>}
   */
  async function collectProfileNotes() {
    const initial = await callMainWorld('profile-notes');
    if (!initial) {
      throw new Error('无法读取页面笔记列表(需要 Chrome 111+,或页面未加载完成,请刷新后重试)');
    }
    const container = findScrollContainer();
    let items = dedupeById(initial);
    let last = items.length;
    let stale = 0;
    while (stale < STALE_ROUNDS_LIMIT && !state.cancelled) {
      container.scrollTop = container.scrollHeight;
      window.scrollTo(0, document.documentElement.scrollHeight);
      await sleep(SCROLL_WAIT_MS);
      const next = await callMainWorld('profile-notes');
      if (next) items = dedupeById(next);
      setStatus(`正在滚动收集笔记… 已发现 ${items.length} 篇`);
      if (items.length === last) stale += 1;
      else {
        stale = 0;
        last = items.length;
      }
    }
    container.scrollTop = 0; // 滚回顶部,减少对页面的扰动
    window.scrollTo(0, 0);
    return items;
  }

  /** 用 noteId + xsec_token 构造可访问的笔记页地址 */
  function buildNoteUrl(item) {
    return `${location.origin}/explore/${item.noteId}?xsec_token=${encodeURIComponent(item.xsecToken)}&xsec_source=pc_user`;
  }

  // ---------- UI ----------

  function ensureUI() {
    if (ui.root) return;
    const root = document.createElement('div');
    root.id = 'xhs-dl-root';
    root.innerHTML = `
      <div class="xhs-dl-panel" hidden>
        <div class="xhs-dl-panel-head">
          <span class="xhs-dl-panel-title">小红书笔记下载</span>
          <button class="xhs-dl-close" title="隐藏面板">×</button>
        </div>
        <div class="xhs-dl-status">准备中…</div>
        <div class="xhs-dl-progress" hidden><div class="xhs-dl-progress-inner"></div></div>
        <div class="xhs-dl-log"></div>
        <div class="xhs-dl-path" hidden></div>
        <div class="xhs-dl-actions">
          <button class="xhs-dl-open" hidden>📂 打开目录</button>
          <button class="xhs-dl-cancel">取消下载</button>
        </div>
      </div>
      <button class="xhs-dl-btn" hidden>下载</button>
    `;
    (document.body || document.documentElement).appendChild(root);

    ui.root = root;
    ui.panel = root.querySelector('.xhs-dl-panel');
    ui.title = root.querySelector('.xhs-dl-panel-title');
    ui.status = root.querySelector('.xhs-dl-status');
    ui.progress = root.querySelector('.xhs-dl-progress');
    ui.bar = root.querySelector('.xhs-dl-progress-inner');
    ui.log = root.querySelector('.xhs-dl-log');
    ui.path = root.querySelector('.xhs-dl-path');
    ui.open = root.querySelector('.xhs-dl-open');
    ui.cancel = root.querySelector('.xhs-dl-cancel');
    ui.btn = root.querySelector('.xhs-dl-btn');

    root.querySelector('.xhs-dl-close').addEventListener('click', () => {
      ui.panel.hidden = true; // 仅隐藏面板,不中断进行中的任务
    });
    ui.open.addEventListener('click', async () => {
      if (state.openId === null) return;
      ui.open.disabled = true;
      // 回退方案:查实际保存路径,在浏览器标签页打开所在目录
      const openFallback = async () => {
        const p = await queryDownloadPath(state.openId);
        if (!p) throw new Error('未查到保存路径');
        const tab = await chrome.runtime.sendMessage({ type: 'open-folder-tab', path: dirname(p) });
        if (!tab || !tab.ok) throw new Error((tab && tab.error) || '打开目录标签页失败');
        setStatus(`已打开目录:${dirname(p)}`);
      };
      try {
        try {
          const res = await chrome.runtime.sendMessage({ type: 'show-in-folder', downloadId: state.openId });
          if (res && res.ok) {
            setStatus('已在系统文件管理器中定位文件 ✓');
            return;
          }
          log(`⚠ 系统定位失败:${(res && res.error) || '未知错误'},改用标签页打开目录…`, 'warn');
        } catch (e) {
          // 消息通道异常(如 SW 报错)同样走回退,不直接放弃
          log(`⚠ 系统定位失败:${e.message},改用标签页打开目录…`, 'warn');
        }
        await openFallback();
      } catch (e) {
        setStatus(`❌ 打开目录失败:${e.message}`);
        log(e.message, 'err');
      } finally {
        ui.open.disabled = false;
      }
    });
    ui.cancel.addEventListener('click', () => {
      if (state.running) {
        state.cancelled = true;
        ui.cancel.disabled = true;
        ui.cancel.textContent = '正在取消…';
      } else {
        ui.panel.hidden = true;
      }
    });
    ui.btn.addEventListener('click', () => {
      const type = getPageType();
      if (type === 'profile') runBatchDownload();
      else if (type === 'note') runSingleDownload();
    });
  }

  /**
   * 在笔记页「关注」按钮旁注入内联下载按钮。
   * 注意:页面 DOM 里可能同时存在一份隐藏的备用布局(display:none 的 .author 副本),
   * 必须挑「可见」的关注按钮作锚点,否则按钮会被藏进不可见容器里。
   * 页面是 React 渲染,重渲染可能移除按钮,由轮询定时器持续补挂。
   * @returns {boolean} 内联按钮当前是否存在于页面
   */
  function ensureInlineButton() {
    if (getPageType() !== 'note') return false;
    const anchor = [...document.querySelectorAll('.note-detail-follow-btn')].find(isVisible);
    let btn = document.querySelector('.xhs-dl-inline-btn');
    if (btn && anchor && btn.previousElementSibling !== anchor) {
      btn.remove(); // 挂在了隐藏副本旁,摘下来重新挂到可见锚点
      btn = null;
    }
    if (btn) {
      syncInlineButton();
      return true;
    }
    if (!anchor || !anchor.parentElement) {
      syncInlineButton();
      return false;
    }
    btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'xhs-dl-inline-btn';
    btn.title = '下载这篇笔记(图片/视频 + markdown,打包为 zip)';
    btn.addEventListener('click', () => runSingleDownload());
    anchor.insertAdjacentElement('afterend', btn);
    syncInlineButton();
    return true;
  }

  /** 同步内联按钮的文案与禁用状态 */
  function syncInlineButton() {
    const btn = document.querySelector('.xhs-dl-inline-btn');
    if (!btn) return;
    btn.disabled = state.running;
    btn.textContent = state.running ? '下载中…' : '⬇ 下载笔记';
  }

  function refreshButton() {
    const type = getPageType();
    // 以「内联按钮真实可见」为准:若它被藏进隐藏布局,浮动按钮兜底显示,避免两者都不可见
    const hasInline = type === 'note' && isVisible(document.querySelector('.xhs-dl-inline-btn'));
    syncInlineButton();
    if (!type || hasInline) {
      // 非笔记/主页页面,或笔记页已有可见内联按钮时,隐藏右下角浮动按钮
      ui.btn.hidden = true;
      return;
    }
    ui.btn.hidden = false;
    ui.btn.disabled = state.running;
    ui.btn.textContent = type === 'profile' ? '⬇ 下载该博主全部笔记' : '⬇ 下载此笔记';
  }

  function resetPanel(title) {
    ui.panel.hidden = false;
    ui.title.textContent = title;
    ui.status.textContent = '准备中…';
    ui.progress.hidden = true;
    ui.bar.style.width = '0%';
    ui.log.innerHTML = '';
    ui.path.hidden = true;
    ui.path.textContent = '';
    ui.open.hidden = true;
    ui.cancel.hidden = false;
    state.openId = null;
    ui.cancel.disabled = false;
    ui.cancel.textContent = '取消下载';
  }

  function setStatus(text) {
    ui.status.textContent = text;
  }

  function setProgress(cur, total) {
    if (!total) {
      ui.progress.hidden = true;
      return;
    }
    ui.progress.hidden = false;
    ui.bar.style.width = `${Math.round((cur / total) * 100)}%`;
  }

  function log(msg, cls = '') {
    const div = document.createElement('div');
    if (cls) div.className = cls;
    div.textContent = msg;
    ui.log.appendChild(div);
    while (ui.log.childElementCount > LOG_MAX_LINES) ui.log.removeChild(ui.log.firstChild);
    ui.log.scrollTop = ui.log.scrollHeight;
  }

  /**
   * 收尾:下载成功后主按钮直接变为「📂 打开目录」(点它打开 Finder/资源管理器,
   * 面板通过右上角 × 关闭);失败等无 downloadId 的场景保留「完成」按钮用于关闭。
   */
  function markDone(downloadId = null) {
    if (downloadId !== null) {
      state.openId = downloadId;
      ui.open.hidden = false;
      ui.cancel.hidden = true;
    } else {
      ui.cancel.hidden = false;
      ui.cancel.disabled = false;
      ui.cancel.textContent = '完成 ✓(点击关闭)';
    }
  }

  /** 取路径的目录部分(兼容 macOS 的 / 与 Windows 的 \ 分隔符) */
  function dirname(p) {
    const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
    return i > 0 ? p.slice(0, i) : p;
  }

  /** 向 background 查询下载任务的最终保存路径,带重试(刚创建时路径可能尚未落定) */
  async function queryDownloadPath(downloadId) {
    for (let i = 0; i < 5; i += 1) {
      try {
        const res = await chrome.runtime.sendMessage({ type: 'query-path', downloadId });
        if (res && res.ok && res.path) return res.path;
      } catch (_) {
        // 网络或 SW 唤醒延迟,重试
      }
      await sleep(300);
    }
    return null;
  }

  function showPath(text) {
    ui.path.hidden = false;
    ui.path.textContent = text;
  }

  // ---------- 主流程 ----------

  /** 下载当前打开的单篇笔记 */
  async function runSingleDownload() {
    if (state.running) return;
    state.running = true;
    state.cancelled = false;
    resetPanel('下载当前笔记');
    refreshButton();
    let downloadId = null;
    try {
      setStatus('正在获取笔记数据…');
      const note = await fetchNoteData(location.href);
      log(`《${note.title || note.noteId}》 ${note.images.length} 张图片${note.video ? ' + 1 个视频' : ''}`);
      const result = await downloadNote(note, null);
      downloadId = result.downloadId;
      result.errors.forEach((e) => log(`⚠ ${e}`, 'warn'));
      setStatus(
        state.cancelled
          ? '已取消'
          : result.errors.length
            ? `完成,但有 ${result.errors.length} 个文件失败(详见日志)`
            : '✅ 下载完成'
      );
      if (downloadId !== null) {
        const p = await queryDownloadPath(downloadId);
        if (p) showPath(`已保存到:${p}`);
      }
    } catch (e) {
      setStatus(`❌ 失败:${e.message}`);
      log(e.message, 'err');
    } finally {
      state.running = false;
      markDone(downloadId);
      refreshButton();
    }
  }

  /** 下载当前博主主页的全部笔记 */
  async function runBatchDownload() {
    if (state.running) return;
    state.running = true;
    state.cancelled = false;
    resetPanel('下载博主全部笔记');
    refreshButton();
    let ok = 0;
    let fail = 0;
    let lastDownloadId = null;
    try {
      setStatus('正在滚动页面收集笔记…(请保持本页面在前台)');
      const items = await collectProfileNotes();
      if (state.cancelled) {
        setStatus('已取消');
        return;
      }
      if (!items.length) {
        setStatus('❌ 未找到笔记,请确认当前展示的是「笔记」标签页后重试');
        return;
      }
      log(`共发现 ${items.length} 篇笔记,开始逐篇下载…`);
      setProgress(0, items.length);

      for (let i = 0; i < items.length; i += 1) {
        if (state.cancelled) {
          log('已取消,停止后续下载', 'warn');
          break;
        }
        const item = items[i];
        setProgress(i, items.length);
        try {
          const note = await fetchNoteData(buildNoteUrl(item));
          setStatus(`(${i + 1}/${items.length}) 《${trunc(note.title || item.title || item.noteId)}》`);
          const result = await downloadNote(note, i + 1);
          if (result.downloadId !== null) lastDownloadId = result.downloadId;
          if (result.errors.length) {
            fail += 1;
            log(`⚠ 《${trunc(note.title || item.title || item.noteId)}》:${result.errors.join('; ')}`, 'warn');
          } else {
            ok += 1;
          }
        } catch (e) {
          fail += 1;
          log(`✗ (${i + 1}/${items.length}) ${e.message}`, 'err');
          if (/HTTP 4\d\d/.test(e.message)) {
            log('疑似触发限流,暂停 5 秒后继续…', 'warn');
            await sleep(5000);
          }
        }
        await sleep(NOTE_FETCH_INTERVAL_MS + Math.random() * 400);
      }

      setProgress(items.length, items.length);
      setStatus(
        state.cancelled
          ? `已取消:成功 ${ok} 篇,失败 ${fail} 篇`
          : `✅ 完成:成功 ${ok} 篇,失败 ${fail} 篇,共 ${items.length} 篇`
      );
      if (lastDownloadId !== null && ok + fail > 0) {
        const p = await queryDownloadPath(lastDownloadId);
        if (p) showPath(`保存目录:${dirname(p)}(共 ${ok + fail} 个文件)`);
      }
    } catch (e) {
      setStatus(`❌ 失败:${e.message}`);
      log(e.message, 'err');
    } finally {
      state.running = false;
      markDone(lastDownloadId);
      refreshButton();
    }
  }

  // ---------- 启动:SPA 路由监听 + UI 初始化 ----------
  let lastHref = location.href;
  setInterval(() => {
    if (location.href !== lastHref) lastHref = location.href; // 小红书是 SPA,pushState 切页不刷新
    ensureUI();
    ensureInlineButton(); // 笔记页「关注」旁的内联按钮(React 重渲染后自动补挂)
    refreshButton();
  }, URL_WATCH_INTERVAL_MS);
  ensureUI();
  ensureInlineButton();
  refreshButton();
})();
