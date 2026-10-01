# 小红书笔记下载器(Chrome 插件)

一个专注于「下载小红书笔记」的 Chrome 扩展,无任何第三方依赖,不需要 API Key。

## 功能

| 场景 | 操作 |
| --- | --- |
| 打开某篇笔记(`/explore/xxx`) | 笔记页面右上方「关注」按钮旁边出现「⬇ 下载笔记」按钮,点击下载该笔记 |
| 打开博主主页(`/user/profile/xxx`) | 页面右下角出现「⬇ 下载该博主全部笔记」按钮,点击后自动滚动收集全部笔记并逐篇下载 |

下载完成后,进度面板会显示**完整保存路径**,主按钮自动变为「📂 打开目录」,一键在系统文件管理器(macOS Finder / Windows 资源管理器)中定位到文件(面板通过右上角 × 关闭)。

每篇笔记打包为**一个 zip**,命名:`xiaohongshu-笔记标题-发布日期.zip`(如 `xiaohongshu-你好-20260930.zip`),内容:

```
xiaohongshu-你好-20260930.zip
├── 你好.md            # 笔记内容(markdown):标题/博主/时间/标签/正文,图片按相对路径引用
├── images/
│   ├── 01.jpg         # 图片笔记:全部图片(CDN 的 webp/avif 已自动转为 jpg,双击即开)
│   └── cover.jpg      # 视频笔记:封面
└── video.mp4          # 视频笔记:视频
```

保存位置(位于浏览器默认下载目录下):

```
小红书下载/
└── 博主昵称/
    ├── 001_xiaohongshu-你好-20260930.zip   # 批量下载带序号前缀,保持笔记顺序
    └── 002_xiaohongshu-世界-20260928.zip
```

单篇下载时 zip 直接放在博主文件夹下,没有序号前缀。markdown 里图片/视频用相对路径引用,在 Typora、Obsidian 等编辑器中打开 `.md` 即可图文混排。

## 安装

1. 打开 Chrome,访问 `chrome://extensions/`
2. 右上角打开「开发者模式」
3. 点击「加载已解压的扩展程序」,选择本目录(包含 `manifest.json` 的文件夹)
4. 打开 [www.xiaohongshu.com](https://www.xiaohongshu.com) 并**登录**,即可使用

## 工作原理

- 插件通过页面同源 `fetch` 请求笔记页 HTML(自动携带登录 Cookie 和 `xsec_token`)
- 从 HTML 中的 `window.__INITIAL_STATE__.note.noteDetailMap` 提取图片/视频直链与笔记信息(不调用需要签名的内部 API,稳定性更好)
- 批量下载时,逐篇笔记的 `xsec_token` 由注入页面 JS 环境的 `main.js` 从页面 state 读取回传(2024 年后小红书笔记链接必须带 token 才能访问)
- 图片字节优先由后台 Service Worker 抓取(扩展声明了 `xhscdn.com`/`rednotecdn.com` 的 host 权限,不受页面跨域限制,失败时回退页面内直接抓取);CDN 返回的 webp/avif 自动转为 jpg
- 抓取到的媒体用内置的 `zip.js`(纯原生 ZIP/STORE 实现,无第三方库)打包成单个 zip
- zip 的 blob URL 交给后台 `chrome.downloads` 落盘,并经 `onDeterminingFilename` 改名到「小红书下载/博主/」子目录(Chrome 会忽略跨上下文 blob URL 的 filename 参数;失败时自动降级为浏览器直接下载)
- 批量下载时自动滚动博主主页加载全部笔记,逐篇处理并带进度面板,可随时取消

环境要求:Chrome 111+(需要 manifest 中的 MAIN world 注入能力)。

## 注意事项

- **需要登录**小红书网页版,否则拿不到笔记数据
- 批量收集笔记阶段会**自动滚动页面**,请保持该标签页在前台(后台标签页会被浏览器限速)
- 笔记之间有约 0.6~1 秒的间隔(防止触发风控),大博主下载耗时较长属正常现象
- 出现少量失败(如删除/仅自己可见的笔记)会在日志面板中标注,不影响其余笔记
- 隐私:所有数据只在本地浏览器内处理,不上传任何服务器
- 请仅用于个人备份,尊重原作者版权,勿用于二次分发

## 文件结构

```
manifest.json   # 插件清单(MV3)
background.js   # Service Worker,负责调用 chrome.downloads 落盘
main.js         # MAIN world 脚本:读取页面 state 中的笔记列表和 xsec_token
zip.js          # 纯原生 ZIP 打包(STORE 不压缩 + CRC32,支持中文文件名)
content.js      # 内容脚本:按钮/进度 UI、笔记数据解析、批量收集与下载流程
content.css     # 注入页面的 UI 样式
```
