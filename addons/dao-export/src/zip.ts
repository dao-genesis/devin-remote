/**
 * Minimal ZIP writer — zero dependencies (STORE + DEFLATE via zlib).
 */
import * as zlib from 'zlib';

interface ZipEntry {
  name: string;
  data: Buffer;
  compressed: Buffer;
  crc: number;
  offset: number;
  method: number;
}

function crc32(buf: Buffer): number {
  let table = crc32.table;
  if (!table) {
    table = new Int32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      table[i] = c;
    }
    crc32.table = table;
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}
namespace crc32 {
  export let table: Int32Array | undefined;
}

export class ZipWriter {
  private entries: ZipEntry[] = [];
  private chunks: Buffer[] = [];
  private offset = 0;

  addFile(name: string, data: Buffer | string): void {
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf-8') : data;
    const nameBuf = Buffer.from(name.replace(/\\/g, '/'), 'utf-8');
    const crc = crc32(buf);

    let compressed: Buffer = Buffer.from(zlib.deflateRawSync(buf, { level: 6 }));
    let method = 8;
    if (compressed.length >= buf.length) {
      compressed = buf;
      method = 0;
    }

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4); // version
    header.writeUInt16LE(0x0800, 6); // UTF-8 flag
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(0, 10); // time
    header.writeUInt16LE(0x21, 12); // date (1980-01-01)
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(buf.length, 22);
    header.writeUInt16LE(nameBuf.length, 26);
    header.writeUInt16LE(0, 28);

    const entryOffset = this.offset;
    this.chunks.push(header, nameBuf, compressed);
    this.offset += header.length + nameBuf.length + compressed.length;

    this.entries.push({
      name: nameBuf.toString('utf-8'),
      data: buf,
      compressed,
      crc,
      offset: entryOffset,
      method,
    });
  }

  toBuffer(): Buffer {
    const centralStart = this.offset;
    const centralChunks: Buffer[] = [];
    let centralSize = 0;

    for (const e of this.entries) {
      const nameBuf = Buffer.from(e.name, 'utf-8');
      const rec = Buffer.alloc(46);
      rec.writeUInt32LE(0x02014b50, 0);
      rec.writeUInt16LE(20, 4);
      rec.writeUInt16LE(20, 6);
      rec.writeUInt16LE(0x0800, 8);
      rec.writeUInt16LE(e.method, 10);
      rec.writeUInt16LE(0, 12);
      rec.writeUInt16LE(0x21, 14);
      rec.writeUInt32LE(e.crc, 16);
      rec.writeUInt32LE(e.compressed.length, 20);
      rec.writeUInt32LE(e.data.length, 24);
      rec.writeUInt16LE(nameBuf.length, 28);
      rec.writeUInt16LE(0, 30);
      rec.writeUInt16LE(0, 32);
      rec.writeUInt16LE(0, 34);
      rec.writeUInt16LE(0, 36);
      rec.writeUInt32LE(0, 38);
      rec.writeUInt32LE(e.offset, 42);
      centralChunks.push(rec, nameBuf);
      centralSize += rec.length + nameBuf.length;
    }

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(this.entries.length, 8);
    eocd.writeUInt16LE(this.entries.length, 10);
    eocd.writeUInt32LE(centralSize, 12);
    eocd.writeUInt32LE(centralStart, 16);
    eocd.writeUInt16LE(0, 20);

    return Buffer.concat([...this.chunks, ...centralChunks, eocd]);
  }
}
