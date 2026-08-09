// ============================================================
// zip.ts — 极简 ZIP 打包/解析（无外部依赖）
// 支持 store(0) / deflate(8)，UTF-8 文件名；不含 zip64/加密
// ============================================================

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

const ZIP_LOCAL_HEADER = 0x04034b50;
const ZIP_CENTRAL_HEADER = 0x02014b50;
const ZIP_EOCD = 0x06054b50;
const ZIP_VERSION = 20;
const ZIP_UTF8_FLAG = 0x0800;

let crcTable: Uint32Array | null = null;

function getCrcTable(): Uint32Array {
  if (!crcTable) {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      table[n] = c >>> 0;
    }
    crcTable = table;
  }
  return crcTable;
}

/** CRC-32（ZIP 规范） */
export function crc32(data: Uint8Array): number {
  const table = getCrcTable();
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = table[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const hasRawDeflate =
  typeof CompressionStream !== "undefined" &&
  typeof DecompressionStream !== "undefined";

async function readAll(
  stream: ReadableStream<Uint8Array>
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  return concatBytes(chunks);
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new CompressionStream("deflate-raw");
  // 必须先消费 readable，否则大输入的输出队列反压会导致 write/close 死锁
  const readPromise = readAll(stream.readable);
  const writer = stream.writable.getWriter();
  await writer.write(data);
  await writer.close();
  return readPromise;
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new DecompressionStream("deflate-raw");
  const readPromise = readAll(stream.readable);
  const writer = stream.writable.getWriter();
  await writer.write(data);
  await writer.close();
  return readPromise;
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function readU16(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readU32(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] |
      (bytes[offset + 1] << 8) |
      (bytes[offset + 2] << 16) |
      (bytes[offset + 3] << 24)) >>>
    0
  );
}

/** 把若干条目打包成 ZIP 字节流 */
export async function createZip(entries: ZipEntry[]): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: {
    name: Uint8Array;
    method: number;
    crc: number;
    csize: number;
    usize: number;
    offset: number;
  }[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const usize = entry.data.length;
    let compressed = entry.data;
    let method = 0;
    if (usize > 0 && hasRawDeflate) {
      try {
        compressed = await deflateRaw(entry.data);
        method = 8;
      } catch {
        compressed = entry.data;
        method = 0;
      }
    }
    const crc = crc32(entry.data);

    const header = new Uint8Array(30);
    const h = new DataView(header.buffer);
    h.setUint32(0, ZIP_LOCAL_HEADER, true);
    h.setUint16(4, ZIP_VERSION, true);
    h.setUint16(6, ZIP_UTF8_FLAG, true);
    h.setUint16(8, method, true);
    h.setUint16(10, 0, true);
    h.setUint16(12, 0x21, true);
    h.setUint32(14, crc, true);
    h.setUint32(18, compressed.length, true);
    h.setUint32(22, usize, true);
    h.setUint16(26, name.length, true);
    h.setUint16(28, 0, true);
    chunks.push(header, name, compressed);

    central.push({
      name,
      method,
      crc,
      csize: compressed.length,
      usize,
      offset,
    });
    offset += header.length + name.length + compressed.length;
  }

  const cdStart = offset;
  const cdChunks: Uint8Array[] = [];
  for (const c of central) {
    const cd = new Uint8Array(46);
    const d = new DataView(cd.buffer);
    d.setUint32(0, ZIP_CENTRAL_HEADER, true);
    d.setUint16(4, ZIP_VERSION, true);
    d.setUint16(6, ZIP_VERSION, true);
    d.setUint16(8, ZIP_UTF8_FLAG, true);
    d.setUint16(10, c.method, true);
    d.setUint16(12, 0, true);
    d.setUint16(14, 0x21, true);
    d.setUint32(16, c.crc, true);
    d.setUint32(20, c.csize, true);
    d.setUint32(24, c.usize, true);
    d.setUint16(28, c.name.length, true);
    d.setUint16(30, 0, true);
    d.setUint16(32, 0, true);
    d.setUint16(34, 0, true);
    d.setUint16(36, 0, true);
    d.setUint32(38, 0, true);
    d.setUint32(42, c.offset, true);
    cdChunks.push(cd, c.name);
    offset += cd.length + c.name.length;
  }
  const cdSize = offset - cdStart;

  const eocd = new Uint8Array(22);
  const e = new DataView(eocd.buffer);
  e.setUint32(0, ZIP_EOCD, true);
  e.setUint16(4, 0, true);
  e.setUint16(6, 0, true);
  e.setUint16(8, central.length, true);
  e.setUint16(10, central.length, true);
  e.setUint32(12, cdSize, true);
  e.setUint32(16, cdStart, true);
  e.setUint16(20, 0, true);

  return concatBytes([...chunks, ...cdChunks, eocd]);
}

/** 解析 ZIP 字节流为 文件名 → 内容 */
export async function parseZip(
  bytes: Uint8Array
): Promise<Map<string, Uint8Array>> {
  if (bytes.length < 22) throw new Error("无效的 ZIP 文件");

  let eocd = -1;
  const searchStart = Math.max(0, bytes.length - 22 - 0xffff);
  for (let i = bytes.length - 22; i >= searchStart; i--) {
    if (readU32(bytes, i) === ZIP_EOCD) {
      const commentLen = readU16(bytes, i + 20);
      if (i + 22 + commentLen === bytes.length) {
        eocd = i;
        break;
      }
    }
  }
  if (eocd < 0) throw new Error("无效的 ZIP 文件（找不到结束记录）");

  const count = readU16(bytes, eocd + 10);
  let cdOffset = readU32(bytes, eocd + 16);
  const decoder = new TextDecoder();
  const files = new Map<string, Uint8Array>();

  for (let n = 0; n < count; n++) {
    if (
      cdOffset + 46 > bytes.length ||
      readU32(bytes, cdOffset) !== ZIP_CENTRAL_HEADER
    ) {
      throw new Error("ZIP 中央目录损坏");
    }
    const method = readU16(bytes, cdOffset + 10);
    const csize = readU32(bytes, cdOffset + 20);
    const usize = readU32(bytes, cdOffset + 24);
    const nameLen = readU16(bytes, cdOffset + 28);
    const extraLen = readU16(bytes, cdOffset + 30);
    const commentLen = readU16(bytes, cdOffset + 32);
    const localOffset = readU32(bytes, cdOffset + 42);
    if (
      csize === 0xffffffff ||
      usize === 0xffffffff ||
      localOffset === 0xffffffff
    ) {
      throw new Error("暂不支持 ZIP64 工程包");
    }
    const name = decoder.decode(
      bytes.subarray(cdOffset + 46, cdOffset + 46 + nameLen)
    );
    cdOffset += 46 + nameLen + extraLen + commentLen;

    if (
      localOffset + 30 > bytes.length ||
      readU32(bytes, localOffset) !== ZIP_LOCAL_HEADER
    ) {
      throw new Error(`ZIP 条目损坏: ${name}`);
    }
    const localNameLen = readU16(bytes, localOffset + 26);
    const localExtraLen = readU16(bytes, localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    if (dataStart + csize > bytes.length) {
      throw new Error(`ZIP 条目数据不完整: ${name}`);
    }

    let data = bytes.subarray(dataStart, dataStart + csize);
    if (method === 8) {
      data = await inflateRaw(data);
    } else if (method !== 0) {
      throw new Error(`不支持的 ZIP 压缩方式: ${method}`);
    }
    files.set(name, data);
  }

  return files;
}
