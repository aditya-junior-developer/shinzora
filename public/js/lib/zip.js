/* ==========================================================================
   Shinzora — ZIP writer
   --------------------------------------------------------------------------
   Export used to write every generated file into one concatenated .txt blob.
   A customer who downloaded their project got a text file, not a project.

   This is a real ZIP archive written in the browser: local file headers, a
   central directory and an end-of-central-directory record, with a correct
   CRC-32 for every entry. Entries are stored (method 0) rather than deflated —
   HTML/CSS/JS is small, so the archive stays readable by every tool (Windows
   Explorer, macOS Archive Utility, `unzip`, CI checkouts) without pulling in a
   compression library.

   No dependencies, no network, works offline.
   ========================================================================== */

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL = 0x06054b50;
const VERSION = 20; // 2.0 — the floor for stored entries
const FLAG_UTF8 = 0x0800; // file names are UTF-8

/* --------------------------------------------------------------- crc-32 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value >>> 0;
  }
  return table;
})();

/** CRC-32 of a byte array, as an unsigned 32-bit number. */
export function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/* --------------------------------------------------------------- writing */
function utf8(text) {
  return new TextEncoder().encode(text);
}

/** MS-DOS date and time, as ZIP has stored them since 1989. */
function dosStamp(date) {
  const time =
    (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  /* ZIP counts years from 1980; a pre-1980 clock is clamped rather than wrapped. */
  const year = Math.max(1980, date.getFullYear()) - 1980;
  const day = ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, date: (year << 9) | day };
}

function writer(size) {
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  let at = 0;
  return {
    bytes,
    u16(value) {
      view.setUint16(at, value, true);
      at += 2;
    },
    u32(value) {
      view.setUint32(at, value >>> 0, true);
      at += 4;
    },
    raw(chunk) {
      bytes.set(chunk, at);
      at += chunk.length;
    },
    get offset() {
      return at;
    }
  };
}

/**
 * Normalise a path so the archive never contains an absolute path, a drive
 * letter or `..`, whichever of those the model happened to emit.
 */
export function safeEntryName(name) {
  const cleaned = String(name ?? "")
    .replace(/\\/g, "/")
    .replace(/^[a-zA-Z]:/, "")
    .replace(/^\/+/, "")
    .split("/")
    .filter((part) => part && part !== "." && part !== "..")
    .join("/");
  return cleaned || "index.html";
}

/**
 * Build a ZIP archive.
 *
 * @param {Record<string, string|Uint8Array>} files  path → contents
 * @param {{ root?: string, date?: Date }} [options]
 * @returns {Uint8Array}
 */
export function createZip(files, options = {}) {
  const root = options.root ? safeEntryName(options.root).replace(/\/+$/, "") : "";
  const stamp = dosStamp(options.date instanceof Date ? options.date : new Date());

  const entries = Object.entries(files || {})
    .map(([name, content]) => {
      const path = root ? `${root}/${safeEntryName(name)}` : safeEntryName(name);
      const data = content instanceof Uint8Array ? content : utf8(String(content ?? ""));
      return { path, nameBytes: utf8(path), data, crc: crc32(data) };
    })
    /* Deterministic order: the same project always exports the same archive. */
    .sort((a, b) => a.path.localeCompare(b.path));

  if (!entries.length) throw new Error("There are no files to export.");

  const localSize = entries.reduce((sum, entry) => sum + 30 + entry.nameBytes.length + entry.data.length, 0);
  const centralSize = entries.reduce((sum, entry) => sum + 46 + entry.nameBytes.length, 0);
  const out = writer(localSize + centralSize + 22);

  const offsets = [];
  for (const entry of entries) {
    offsets.push(out.offset);
    out.u32(LOCAL_HEADER);
    out.u16(VERSION);
    out.u16(FLAG_UTF8);
    out.u16(0); // stored
    out.u16(stamp.time);
    out.u16(stamp.date);
    out.u32(entry.crc);
    out.u32(entry.data.length);
    out.u32(entry.data.length);
    out.u16(entry.nameBytes.length);
    out.u16(0); // no extra field
    out.raw(entry.nameBytes);
    out.raw(entry.data);
  }

  const centralStart = out.offset;
  entries.forEach((entry, index) => {
    out.u32(CENTRAL_HEADER);
    out.u16(VERSION); // made by
    out.u16(VERSION); // needed to extract
    out.u16(FLAG_UTF8);
    out.u16(0);
    out.u16(stamp.time);
    out.u16(stamp.date);
    out.u32(entry.crc);
    out.u32(entry.data.length);
    out.u32(entry.data.length);
    out.u16(entry.nameBytes.length);
    out.u16(0); // extra
    out.u16(0); // comment
    out.u16(0); // disk number
    out.u16(0); // internal attributes
    out.u32(0); // external attributes
    out.u32(offsets[index]);
    out.raw(entry.nameBytes);
  });

  const centralEnd = out.offset;
  out.u32(END_OF_CENTRAL);
  out.u16(0); // this disk
  out.u16(0); // disk with the central directory
  out.u16(entries.length);
  out.u16(entries.length);
  out.u32(centralEnd - centralStart);
  out.u32(centralStart);
  out.u16(0); // no archive comment

  return out.bytes;
}

/** Convenience wrapper: a Blob with the right MIME type, ready to download. */
export function zipBlob(files, options = {}) {
  return new Blob([createZip(files, options)], { type: "application/zip" });
}
