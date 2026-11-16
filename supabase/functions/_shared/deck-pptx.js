/* ==========================================================================
   Business summary PowerPoint (brief 2)
   --------------------------------------------------------------------------
   A dependency-free .pptx writer. A .pptx is a zip of OOXML parts; this file
   writes those parts as text and packs them with a store-only zip (no
   compression), which every PowerPoint, Keynote and LibreOffice reads.

   One 16:9 slide per entry in `slides`, on the Shinzora dark background with
   the violet accent. Text uses Arial, so no font file is embedded.

   Plain ES module with no platform imports: the Edge Function imports it under
   Deno, and tests/deck-pptx.test.mjs imports it under Node.
   ========================================================================== */

import { normaliseSlides } from "./deck-pdf.js";

const SLIDE_W = 12192000; // 13.333 in, in EMU
const SLIDE_H = 6858000; // 7.5 in
const BG = "0D0A15";
const ACCENT = "6D45F5";
const INK = "F4F1FB";
const SOFT = "CFC8E4";

const NS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

/** Escape text for an XML element or attribute, and drop control characters. */
export function xmlText(value) {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function textBox({ id, name, x, y, cx, cy, paragraphs }) {
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${xmlText(name)}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>` +
    `<p:txBody><a:bodyPr wrap="square" lIns="0" rIns="0" tIns="0" bIns="0" anchor="t"><a:normAutofit/></a:bodyPr><a:lstStyle/>` +
    paragraphs.join("") +
    `</p:txBody></p:sp>`
  );
}

function run(text, { size, color, bold = false }) {
  return `<a:r><a:rPr lang="en-IN" sz="${size}" b="${bold ? 1 : 0}" dirty="0"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:latin typeface="Arial"/><a:cs typeface="Arial"/></a:rPr><a:t>${xmlText(text)}</a:t></a:r>`;
}

function bar({ id, x, y, cx, cy, color }) {
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Accent ${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:ln><a:noFill/></a:ln></p:spPr>` +
    `<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="en-IN"/></a:p></p:txBody></p:sp>`
  );
}

/** One slide: a violet rule, the title, and the bullets. */
export function slideXml(slide, index, total) {
  const shapes = [];
  shapes.push(bar({ id: 2, x: 609600, y: 548640, cx: 914400, cy: 54864, color: ACCENT }));
  shapes.push(
    textBox({
      id: 3,
      name: "Title",
      x: 609600,
      y: 731520,
      cx: 10972800,
      cy: 1005840,
      paragraphs: [`<a:p>${run(slide.title, { size: 3200, color: INK, bold: true })}</a:p>`]
    })
  );
  const bullets = slide.bullets.map(
    (text) =>
      `<a:p><a:pPr marL="285750" indent="-285750"><a:spcBef><a:spcPts val="900"/></a:spcBef><a:buClr><a:srgbClr val="${ACCENT}"/></a:buClr><a:buFont typeface="Arial"/><a:buChar char="&#8226;"/></a:pPr>${run(text, { size: 1800, color: SOFT })}</a:p>`
  );
  if (bullets.length) {
    shapes.push(textBox({ id: 4, name: "Body", x: 609600, y: 1966000, cx: 10972800, cy: 4114800, paragraphs: bullets }));
  }
  shapes.push(
    textBox({
      id: 5,
      name: "Footer",
      x: 609600,
      y: 6309360,
      cx: 10972800,
      cy: 274320,
      paragraphs: [`<a:p>${run(`SHINZORA · ${index + 1} / ${total}`, { size: 1000, color: "8E88A8" })}</a:p>`]
    })
  );
  return (
    HEAD +
    `<p:sld ${NS}><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="${BG}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>` +
    `<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
    `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>` +
    shapes.join("") +
    `</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`
  );
}

const THEME =
  HEAD +
  `<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Shinzora"><a:themeElements>` +
  `<a:clrScheme name="Shinzora"><a:dk1><a:srgbClr val="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1>` +
  `<a:dk2><a:srgbClr val="${BG}"/></a:dk2><a:lt2><a:srgbClr val="${INK}"/></a:lt2>` +
  `<a:accent1><a:srgbClr val="${ACCENT}"/></a:accent1><a:accent2><a:srgbClr val="DB2777"/></a:accent2>` +
  `<a:accent3><a:srgbClr val="47E6FF"/></a:accent3><a:accent4><a:srgbClr val="FFD45C"/></a:accent4>` +
  `<a:accent5><a:srgbClr val="9D7BFF"/></a:accent5><a:accent6><a:srgbClr val="A7F3D0"/></a:accent6>` +
  `<a:hlink><a:srgbClr val="${ACCENT}"/></a:hlink><a:folHlink><a:srgbClr val="9D7BFF"/></a:folHlink></a:clrScheme>` +
  `<a:fontScheme name="Shinzora"><a:majorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>` +
  `<a:minorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>` +
  `<a:fmtScheme name="Shinzora"><a:fillStyleLst>` +
  `<a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>` +
  `</a:fillStyleLst><a:lnStyleLst>` +
  `<a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>` +
  `</a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>` +
  `<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst>` +
  `</a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>`;

const EMPTY_TREE =
  `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
  `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>`;

const MASTER =
  HEAD +
  `<p:sldMaster ${NS}><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="${BG}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>` +
  `<p:spTree>${EMPTY_TREE}</p:spTree></p:cSld>` +
  `<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>` +
  `<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>` +
  `<p:txStyles><p:titleStyle><a:lvl1pPr><a:defRPr sz="3200"/></a:lvl1pPr></p:titleStyle><p:bodyStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:bodyStyle><p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:otherStyle></p:txStyles></p:sldMaster>`;

const LAYOUT =
  HEAD +
  `<p:sldLayout ${NS} type="blank" preserve="1"><p:cSld name="Blank"><p:spTree>${EMPTY_TREE}</p:spTree></p:cSld>` +
  `<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;

const REL_NS = 'xmlns="http://schemas.openxmlformats.org/package/2006/relationships"';
const RT = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const rels = (items) =>
  HEAD +
  `<Relationships ${REL_NS}>` +
  items.map((item) => `<Relationship Id="${item.id}" Type="${RT}/${item.type}" Target="${item.target}"/>`).join("") +
  `</Relationships>`;

/* ------------------------------------------------------------------ zip */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** A store-only zip of `files` ({ name, data: Uint8Array }). Fixed timestamps keep the output stable. */
export function zipStore(files) {
  const enc = new TextEncoder();
  const DOS_TIME = 0;
  const DOS_DATE = (2026 - 1980) << 9 | (11 << 5) | 16;
  const parts = [];
  const central = [];
  let offset = 0;
  for (const file of files) {
    const name = enc.encode(file.name);
    const data = file.data;
    const crc = crc32(data);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true); // UTF-8 names
    lv.setUint16(8, 0, true); // stored
    lv.setUint16(10, DOS_TIME, true);
    lv.setUint16(12, DOS_DATE, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true);
    local.set(name, 30);
    parts.push(local, data);

    const entry = new Uint8Array(46 + name.length);
    const cv = new DataView(entry.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, DOS_TIME, true);
    cv.setUint16(14, DOS_DATE, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    entry.set(name, 46);
    central.push(entry);
    offset += local.length + data.length;
  }
  const centralSize = central.reduce((n, e) => n + e.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + centralSize + end.length);
  let pos = 0;
  for (const chunk of [...parts, ...central, end]) {
    out.set(chunk, pos);
    pos += chunk.length;
  }
  return out;
}

/* ------------------------------------------------------------------ deck */

/**
 * The whole presentation as a .pptx (Uint8Array). Throws when there is nothing
 * to show, the same way the PDF builder does, so an empty summary is never sent.
 */
export function buildDeckPptx({ title, slides }) {
  const clean = normaliseSlides(slides);
  if (!clean.length) throw new Error("A summary needs at least one slide before it can be exported.");
  const enc = new TextEncoder();
  const total = clean.length;
  const files = [];
  const add = (name, text) => files.push({ name, data: enc.encode(text) });

  add(
    "[Content_Types].xml",
    HEAD +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>' +
      '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>' +
      '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>' +
      '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>' +
      clean
        .map(
          (_, i) =>
            `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`
        )
        .join("") +
      "</Types>"
  );
  add("_rels/.rels", rels([{ id: "rId1", type: "officeDocument", target: "ppt/presentation.xml" }]));
  add(
    "ppt/presentation.xml",
    HEAD +
      `<p:presentation ${NS} saveSubsetFonts="1">` +
      `<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>` +
      `<p:sldIdLst>${clean.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`).join("")}</p:sldIdLst>` +
      `<p:sldSz cx="${SLIDE_W}" cy="${SLIDE_H}"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`
  );
  add(
    "ppt/_rels/presentation.xml.rels",
    rels([
      { id: "rId1", type: "slideMaster", target: "slideMasters/slideMaster1.xml" },
      ...clean.map((_, i) => ({ id: `rId${i + 2}`, type: "slide", target: `slides/slide${i + 1}.xml` })),
      { id: `rId${total + 2}`, type: "theme", target: "theme/theme1.xml" }
    ])
  );
  add("ppt/slideMasters/slideMaster1.xml", MASTER);
  add(
    "ppt/slideMasters/_rels/slideMaster1.xml.rels",
    rels([
      { id: "rId1", type: "slideLayout", target: "../slideLayouts/slideLayout1.xml" },
      { id: "rId2", type: "theme", target: "../theme/theme1.xml" }
    ])
  );
  add("ppt/slideLayouts/slideLayout1.xml", LAYOUT);
  add(
    "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
    rels([{ id: "rId1", type: "slideMaster", target: "../slideMasters/slideMaster1.xml" }])
  );
  add("ppt/theme/theme1.xml", THEME);
  clean.forEach((slide, i) => {
    add(`ppt/slides/slide${i + 1}.xml`, slideXml(slide, i, total));
    add(
      `ppt/slides/_rels/slide${i + 1}.xml.rels`,
      rels([{ id: "rId1", type: "slideLayout", target: "../slideLayouts/slideLayout1.xml" }])
    );
  });
  void title;
  return zipStore(files);
}
