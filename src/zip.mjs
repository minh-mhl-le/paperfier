import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function dosTimestamp(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

async function filesBelow(root, current = root) {
  const results = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const full = path.join(current, entry.name);
    if (entry.isDirectory()) results.push(...await filesBelow(root, full));
    else if (entry.isFile() && entry.name !== 'source-bundle.zip') {
      results.push({ full, name: path.relative(root, full).split(path.sep).join('/') });
    }
  }
  return results.sort((a, b) => a.name.localeCompare(b.name));
}

export async function writeSourceBundle(rootDirectory, zipPath) {
  const root = path.resolve(rootDirectory);
  const entries = [];
  for (const item of await filesBelow(root)) {
    const data = await readFile(item.full);
    const info = await stat(item.full);
    const compressed = deflateRawSync(data, { level: 9 });
    const useRaw = compressed.length >= data.length;
    const payload = useRaw ? data : compressed;
    const checksum = crc32(data);
    const { time, date } = dosTimestamp(info.mtime);
    const filename = Buffer.from(item.name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(useRaw ? 0 : 8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(filename.length, 26);
    local.writeUInt16LE(0, 28);
    const offset = entries.reduce((sum, entry) => sum + entry.local.length + entry.name.length + entry.payload.length, 0);
    entries.push({ local, name: filename, payload, checksum, time, date, method: useRaw ? 0 : 8, size: data.length, offset });
  }

  const central = entries.map(entry => {
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0x0800, 8);
    record.writeUInt16LE(entry.method, 10);
    record.writeUInt16LE(entry.time, 12);
    record.writeUInt16LE(entry.date, 14);
    record.writeUInt32LE(entry.checksum, 16);
    record.writeUInt32LE(entry.payload.length, 20);
    record.writeUInt32LE(entry.size, 24);
    record.writeUInt16LE(entry.name.length, 28);
    record.writeUInt16LE(0, 30);
    record.writeUInt16LE(0, 32);
    record.writeUInt16LE(0, 34);
    record.writeUInt16LE(0, 36);
    record.writeUInt32LE(0, 38);
    record.writeUInt32LE(entry.offset, 42);
    return Buffer.concat([record, entry.name]);
  });
  const centralBytes = Buffer.concat(central);
  const centralOffset = entries.reduce((sum, entry) => sum + entry.local.length + entry.name.length + entry.payload.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(centralOffset, 16);
  end.writeUInt16LE(0, 20);
  const body = Buffer.concat([
    ...entries.flatMap(entry => [entry.local, entry.name, entry.payload]),
    centralBytes,
    end,
  ]);
  if (body.length >= 0xffff0000) throw new Error('The source bundle exceeds the ZIP64 size limit.');
  await import('node:fs/promises').then(({ writeFile }) => writeFile(zipPath, body));
  return { path: zipPath, files: entries.length, sizeBytes: body.length };
}
