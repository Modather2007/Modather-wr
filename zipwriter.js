// zipwriter.js - builds a ZIP (no compression, files are already compressed) so many files download at once. No libraries.
// files: [{ name: string, data: Uint8Array }]  ->  Uint8Array
const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
export function buildZip(files) {
  const enc = new TextEncoder();
  const d = new Date();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const used = new Set();
  const parts = [];
  const central = [];
  let pos = 0;
  for (const f of files) {
    let name = f.name.replace(/[\\/:*?"<>|]/g, "_");
    if (used.has(name)) {
      const m = name.match(/^(.*?)(\.[^.]*)?$/);
      let i = 2;
      while (used.has(`${m[1]} (${i})${m[2] || ""}`)) i++;
      name = `${m[1]} (${i})${m[2] || ""}`;
    }
    used.add(name);
    const nb = enc.encode(name);
    const crc = crc32(f.data);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true);
    h.setUint16(4, 20, true);
    h.setUint16(6, 0x0800, true); // UTF-8 names
    h.setUint16(8, 0, true);
    h.setUint16(10, time, true);
    h.setUint16(12, date, true);
    h.setUint32(14, crc, true);
    h.setUint32(18, f.data.length, true);
    h.setUint32(22, f.data.length, true);
    h.setUint16(26, nb.length, true);
    h.setUint16(28, 0, true);
    parts.push(new Uint8Array(h.buffer), nb, f.data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 20, true);
    c.setUint16(6, 20, true);
    c.setUint16(8, 0x0800, true);
    c.setUint16(10, 0, true);
    c.setUint16(12, time, true);
    c.setUint16(14, date, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, f.data.length, true);
    c.setUint32(24, f.data.length, true);
    c.setUint16(28, nb.length, true);
    c.setUint32(42, pos, true);
    central.push(new Uint8Array(c.buffer), nb);
    pos += 30 + nb.length + f.data.length;
  }
  let csize = 0;
  for (const p of central) csize += p.length;
  const e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true);
  e.setUint16(8, files.length, true);
  e.setUint16(10, files.length, true);
  e.setUint32(12, csize, true);
  e.setUint32(16, pos, true);
  const all = [...parts, ...central, new Uint8Array(e.buffer)];
  let total = 0;
  for (const p of all) total += p.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of all) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
