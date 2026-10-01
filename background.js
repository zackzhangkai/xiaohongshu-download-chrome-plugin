/**
 * 小红书笔记下载器 - Service Worker
 * 职责:
 *  1. 把 content script 发来的 blob URL 交给 chrome.downloads 落盘
 *     (SW 里没有 URL.createObjectURL,zip 的 blob 只能在 content script 侧创建)
 *  2. 通过 downloads.onDeterminingFilename 把文件改名为「小红书下载/博主/」子路径
 *     (Chrome 会忽略跨上下文 blob URL 下载的 filename 参数,不改名会存成 UUID 文件名)
 *  3. 查询某个下载任务的最终保存路径
 *  4. 在系统文件管理器(Finder / 资源管理器)中定位已下载的文件
 */

// 等待命名的下载:blob URL → 目标相对路径(onDeterminingFilename 事件里消费)
const pendingNames = new Map();
const PENDING_LIMIT = 32; // 登记上限,超出时丢弃最旧的,防泄漏

// 图片素材域名(仅允许小红书官方 CDN,参考采集助手实现)
const IMAGE_HOST_RE = /(^|\.)(xhscdn|rednotecdn)\.com$/;
const IMAGE_MAX_BYTES = 20 * 1024 * 1024;
const IMAGE_TIMEOUT_MS = 15000;

/** Uint8Array → base64(分块转换,避免一次性 String.fromCharCode 超出参数长度上限) */
function bytesToBase64(bytes) {
  let binary = '';
  const STEP = 0x8000;
  for (let i = 0; i < bytes.length; i += STEP) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + STEP));
  }
  return btoa(binary);
}

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  const target = pendingNames.get(item.url);
  if (target) {
    pendingNames.delete(item.url);
    suggest({ filename: target, conflictAction: 'uniquify' });
  } else {
    suggest(); // 非本插件发起的下载,保持 Chrome 默认命名
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return;

  // 抓取图片字节:SW 配合 host_permissions 抓 CDN 不受页面 CORS 限制,返回 base64
  if (msg.type === 'fetch-image') {
    (async () => {
      try {
        if (typeof msg.url !== 'string') throw new Error('无效的图片地址');
        const url = new URL(msg.url);
        if (url.protocol !== 'https:' || !IMAGE_HOST_RE.test(url.hostname) || url.username || url.password) {
          throw new Error('图片地址不在支持的素材域名内');
        }
        const response = await fetch(url.href, {
          credentials: 'omit',
          redirect: 'error',
          signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        if (/^text\/html/i.test(response.headers.get('content-type') || '')) {
          throw new Error('CDN 返回了网页而非图片');
        }
        const buf = new Uint8Array(await response.arrayBuffer());
        if (!buf.byteLength) throw new Error('内容为空');
        if (buf.byteLength > IMAGE_MAX_BYTES) throw new Error('单图超过 20MB');
        sendResponse({
          ok: true,
          b64: bytesToBase64(buf),
          contentType: response.headers.get('content-type') || '',
        });
      } catch (e) {
        sendResponse({ ok: false, error: (e && e.message) || '图片下载失败' });
      }
    })();
    return true; // 异步 sendResponse,保持消息通道开放
  }

  // 下载文件(content script 创建的 blob URL),返回 downloadId
  if (msg.type === 'download') {
    if (typeof msg.url !== 'string' || typeof msg.filename !== 'string' || !msg.filename) {
      sendResponse({ ok: false, error: '无效的下载请求' });
      return false;
    }
    if (pendingNames.size >= PENDING_LIMIT) pendingNames.delete(pendingNames.keys().next().value);
    pendingNames.set(msg.url, msg.filename);
    chrome.downloads.download({ url: msg.url, saveAs: false }, (downloadId) => {
      const err = chrome.runtime.lastError ? chrome.runtime.lastError.message : null;
      if (err || typeof downloadId !== 'number') pendingNames.delete(msg.url);
      sendResponse({ ok: !err && typeof downloadId === 'number', downloadId, error: err });
    });
    return true; // 异步 sendResponse,保持消息通道开放
  }

  // 查询下载任务的保存路径(如 /Users/xxx/Downloads/小红书下载/....zip)
  if (msg.type === 'query-path') {
    if (typeof msg.downloadId !== 'number') {
      sendResponse({ ok: false, error: '无效的下载 ID' });
      return false;
    }
    chrome.downloads.search({ id: msg.downloadId }, (items) => {
      const item = items && items[0];
      sendResponse({ ok: !!(item && item.filename), path: item ? item.filename : null });
    });
    return true;
  }

  // 在系统文件管理器中打开并选中该文件(macOS Finder / Windows 资源管理器)
  if (msg.type === 'show-in-folder') {
    if (!Number.isInteger(msg.downloadId)) {
      sendResponse({ ok: false, error: '无效的下载 ID' });
      return false;
    }
    chrome.downloads.search({ id: msg.downloadId }, (items) => {
      const item = items && items[0];
      if (!item || !item.filename) {
        sendResponse({ ok: false, error: '未找到该下载记录(可能已被清除)' });
        return;
      }
      // 注意:部分 Chrome 版本的 downloads.show 不接受回调参数,必须只传 ID
      chrome.downloads.show(msg.downloadId);
      sendResponse({ ok: true });
    });
    return true;
  }

  // 在新标签页打开本地目录(系统定位失败时的回退方案)
  if (msg.type === 'open-folder-tab') {
    if (typeof msg.path !== 'string' || !msg.path) {
      sendResponse({ ok: false, error: '无效的目录路径' });
      return false;
    }
    let p = msg.path.replace(/\\/g, '/');
    if (!p.startsWith('/')) p = `/${p}`; // Windows 盘符路径(C:/…)→ /C:/…
    chrome.tabs.create({ url: `file://${encodeURI(p)}` }, () => {
      const err = chrome.runtime.lastError ? chrome.runtime.lastError.message : null;
      sendResponse({ ok: !err, error: err });
    });
    return true;
  }
});
