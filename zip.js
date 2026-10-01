/**
 * 小红书笔记下载器 - ZIP 打包模块(content script 共享,无第三方依赖)
 *
 * 实现 ZIP 格式的 STORE(仅存储、不压缩)打包:
 * 图片/视频本身已是压缩格式,再压缩收益极小,STORE 实现简单且快。
 * 文件名按 UTF-8 标志位(bit 11)写入,支持中文。
 * 说明:未实现 ZIP64,单篇笔记内容不会超过 4GB,够用。
 */
window.XhsZip = (() => {
  'use strict';

  // CRC32 查找表(多项式 0xedb88320,ZIP 标准)
  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  /** 转成 ZIP 头部使用的 DOS 时间格式 */
  function dosDateTime(d = new Date()) {
    const time = ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff;
    const date = (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff;
    return { time, date };
  }

  /**
   * 打包生成 zip Blob。
   * @param {Array<{name: string, data: Uint8Array}>} files 文件列表(name 支持目录形式如 images/01.jpg)
   * @returns {Blob}
   */
  function buildZip(files) {
    const encoder = new TextEncoder();
    const parts = []; // Blob 部分:依次为各文件的本地头 + 文件名 + 数据
    const central = []; // 中央目录记录
    let offset = 0;
    const { time, date } = dosDateTime();

    for (const f of files) {
      const nameBytes = encoder.encode(f.name);
      const crc = crc32(f.data);
      const size = f.data.length;

      // ---- 本地文件头(30 字节)----
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); // 固定签名 PK\x03\x04
      lh.setUint16(4, 20, true); // 需要的版本
      lh.setUint16(6, 0x0800, true); // 通用标志:文件名为 UTF-8
      lh.setUint16(8, 0, true); // 压缩方法:STORE
      lh.setUint16(10, time, true);
      lh.setUint16(12, date, true);
      lh.setUint32(14, crc, true);
      lh.setUint32(18, size, true); // 压缩后大小
      lh.setUint32(22, size, true); // 原始大小
      lh.setUint16(26, nameBytes.length, true);
      lh.setUint16(28, 0, true); // 扩展字段长度
      parts.push(new Uint8Array(lh.buffer), nameBytes, f.data);

      // ---- 中央目录记录(46 字节)----
      const cd = new DataView(new ArrayBuffer(46));
      cd.setUint32(0, 0x02014b50, true); // 固定签名 PK\x01\x02
      cd.setUint16(4, 20, true); // 生成方版本
      cd.setUint16(6, 20, true); // 需要的版本
      cd.setUint16(8, 0x0800, true); // UTF-8 文件名
      cd.setUint16(10, 0, true); // 方法:STORE
      cd.setUint16(12, time, true);
      cd.setUint16(14, date, true);
      cd.setUint32(16, crc, true);
      cd.setUint32(20, size, true);
      cd.setUint32(24, size, true);
      cd.setUint16(28, nameBytes.length, true);
      // 30~41:扩展字段/注释/盘号/内外部属性,均保持 0
      cd.setUint32(42, offset, true); // 对应本地文件头的偏移
      central.push(new Uint8Array(cd.buffer), nameBytes);

      offset += 30 + nameBytes.length + size;
    }

    const centralSize = central.reduce((sum, p) => sum + p.length, 0);

    // ---- 结束记录 EOCD(22 字节)----
    const eocd = new DataView(new ArrayBuffer(22));
    eocd.setUint32(0, 0x06054b50, true); // 固定签名 PK\x05\x06
    eocd.setUint16(8, files.length, true); // 本盘文件数
    eocd.setUint16(10, files.length, true); // 总文件数
    eocd.setUint32(12, centralSize, true);
    eocd.setUint32(16, offset, true); // 中央目录起始偏移

    return new Blob([...parts, ...central, new Uint8Array(eocd.buffer)], { type: 'application/zip' });
  }

  return { buildZip };
})();
