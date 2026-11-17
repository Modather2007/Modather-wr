// app.js - the whole app runs in the browser: read the PDF, translate, put the Arabic under each line.
import {
  paragraphsFromItems,
  sentencesToTranslate,
  sentencesOf,
  assembleTranslation,
  makeAnalyzer,
  planInline,
  planPanel,
  wrapText,
} from "./layout.js";
import { buildPdf } from "./pdfwriter.js";

const PDFJS_VERSION = "4.5.136";
const PDFJS_BASE = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}`;
const FONT_STACK =
  '"Segoe UI", Tahoma, "Noto Naskh Arabic", "Noto Sans Arabic", "Geeza Pro", "Arabic Typesetting", Arial, sans-serif';

const $ = (id) => document.getElementById(id);
const APP_VERSION = "v18";

const LANGS = {
  ar: { name: "عربي", rtl: true },
  en: { name: "إنجليزي", rtl: false },
  es: { name: "إسباني", rtl: false },
  it: { name: "إيطالي", rtl: false },
  fr: { name: "فرنسي", rtl: false },
  de: { name: "ألماني", rtl: false },
};
const isRtl = (c) => !!LANGS[c].rtl;

// ------------------------------------------------------------------ small helpers

function setStatus(text, kind) {
  const el = $("status");
  el.textContent = text;
  el.className = "chip " + (kind || "");
}

let toastTimer = null;
function toast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, 6000);
}

const THEME_LABEL = { auto: "المظهر: تلقائي", dark: "المظهر: داكن", light: "المظهر: فاتح" };
function applyTheme(t) {
  const root = document.documentElement;
  if (t === "light" || t === "dark") root.setAttribute("data-theme", t);
  else root.removeAttribute("data-theme");
  $("theme").textContent = THEME_LABEL[t] || THEME_LABEL.auto;
}

function fmtMB(bytes) {
  return (bytes / 1048576).toFixed(0) + " MB";
}

// ------------------------------------------------------------------ translation cache (IndexedDB)

let dbPromise = null;
function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const r = indexedDB.open("mtranslate-cache", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("t");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  return dbPromise;
}

async function cacheGetMany(keys) {
  const out = new Map();
  try {
    const db = await openDb();
    await new Promise((resolve) => {
      const tx = db.transaction("t", "readonly");
      const store = tx.objectStore("t");
      for (const k of keys) {
        const req = store.get(k);
        req.onsuccess = () => {
          if (req.result) out.set(k, req.result);
        };
      }
      tx.oncomplete = resolve;
      tx.onerror = resolve;
      tx.onabort = resolve;
    });
  } catch (e) {
    /* no cache available: just translate again */
  }
  return out;
}

async function cachePutMany(entries) {
  try {
    const db = await openDb();
    await new Promise((resolve) => {
      const tx = db.transaction("t", "readwrite");
      const store = tx.objectStore("t");
      for (const [k, v] of entries) store.put(v, k);
      tx.oncomplete = resolve;
      tx.onerror = resolve;
      tx.onabort = resolve;
    });
  } catch (e) {
    /* ignore */
  }
}

// ------------------------------------------------------------------ translation worker

let worker = null;
let reqId = 0;
const pending = new Map();
const fileProgress = new Map();

function onModelProgress(p) {
  if (!p || !p.file) return;
  if (p.status === "progress" && p.total) fileProgress.set(p.file, { loaded: p.loaded || 0, total: p.total });
  if (p.status === "done" && fileProgress.has(p.file)) {
    const f = fileProgress.get(p.file);
    fileProgress.set(p.file, { loaded: f.total, total: f.total });
  }
  let loaded = 0;
  let total = 0;
  for (const f of fileProgress.values()) {
    loaded += f.loaded;
    total += f.total;
  }
  if (total && loaded < total) {
    setStatus(`تحميل نموذج الترجمة: ${Math.round((loaded / total) * 100)}% (${fmtMB(loaded)} من ${fmtMB(total)})`, "busy");
  }
}

function failAll(message) {
  for (const p of pending.values()) p.reject(new Error(message));
  pending.clear();
}

function getWorker() {
  if (worker) return worker;
  worker = new Worker("./worker.js", { type: "module" });
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === "progress") return onModelProgress(m.p);
    const p = pending.get(m.id);
    if (!p) return;
    if (m.type === "tick") return p.onTick && p.onTick(m.done, m.total);
    pending.delete(m.id);
    if (m.type === "error") p.reject(new Error(m.error));
    else p.resolve(m.type === "result" ? m.out : true);
  };
  worker.onerror = () => {
    worker = null;
    failAll("تعذر تشغيل محرك الترجمة. وصّل النت مرة واحدة وجرّب تاني.");
  };
  return worker;
}

function callWorker(msg, onTick) {
  return new Promise((resolve, reject) => {
    const id = ++reqId;
    pending.set(id, { resolve, reject, onTick });
    getWorker().postMessage({ ...msg, id });
  });
}

// sentences -> Map(sentence -> Arabic or null)
async function translateSentences(list, src, tgt, onTick) {
  const result = new Map();
  const K = (s) => `${src}>${tgt}|${s}`;
  const cached = await cacheGetMany(list.map(K));
  const todo = [];
  for (const s of list) {
    if (cached.has(K(s))) result.set(s, cached.get(K(s)));
    else todo.push(s);
  }
  if (todo.length) {
    const out = await callWorker({ type: "translate", src, tgt, texts: todo }, onTick);
    const toStore = [];
    todo.forEach((s, i) => {
      result.set(s, out[i]);
      if (out[i]) toStore.push([K(s), out[i]]);
    });
    await cachePutMany(toStore);
  }
  return result;
}

// ------------------------------------------------------------------ pdf.js

let pdfjsPromise = null;
function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const lib = await import(`${PDFJS_BASE}/build/pdf.min.mjs`);
      // fetch the worker through the page so the service worker can keep a copy for offline use
      const res = await fetch(`${PDFJS_BASE}/build/pdf.worker.min.mjs`);
      const code = await res.text();
      lib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
      return lib;
    })().catch((e) => {
      pdfjsPromise = null;
      throw e;
    });
  }
  return pdfjsPromise;
}

// ------------------------------------------------------------------ drawing

const measureCtx = document.createElement("canvas").getContext("2d");
function measureFor(px) {
  measureCtx.font = `${px}px ${FONT_STACK}`;
  return (s) => measureCtx.measureText(s).width;
}

function composeInline(src, plan, W, H) {
  const out = document.createElement("canvas");
  out.width = W;
  out.height = plan.totalH;
  const ctx = out.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, out.height);
  ctx.textBaseline = "top";
  const rtl = plan.rtl;
  ctx.direction = rtl ? "rtl" : "ltr";
  ctx.textAlign = rtl ? "right" : "left";

  let prev = 0;
  let offset = 0;
  for (const cut of plan.cuts) {
    if (cut.y > prev) ctx.drawImage(src, 0, prev, W, cut.y - prev, 0, prev + offset, W, cut.y - prev);
    const gy = cut.y + offset;
    // continue the background / card colours through the new gap
    ctx.drawImage(src, 0, Math.max(0, cut.y - 1), W, 1, 0, gy, W, cut.gap);
    let y = gy + 1;
    ctx.fillStyle = "#1F4E79";
    for (const it of cut.items) {
      ctx.font = `${it.fontPx}px ${FONT_STACK}`;
      for (const line of it.lines) {
        ctx.fillText(line, rtl ? it.x1 : it.x0, y);
        y += it.lineH;
      }
      y += it.fontPx * 0.6;
    }
    offset += cut.gap;
    prev = cut.y;
  }
  if (prev < H) ctx.drawImage(src, 0, prev, W, H - prev, 0, prev + offset, W, H - prev);
  return out;
}

function composePanel(src, plan, W, H, S) {
  const out = document.createElement("canvas");
  out.width = W;
  out.height = plan.totalH;
  const ctx = out.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, out.height);
  ctx.drawImage(src, 0, 0);
  ctx.fillStyle = "#f0f4ff";
  ctx.fillRect(0, H, W, plan.extra);
  ctx.fillStyle = "#1F4E79";
  ctx.fillRect(0, H, W, Math.max(1, 1.5 * S));
  ctx.textBaseline = "top";
  let y = H + 12 * S;
  for (const it of plan.items) {
    ctx.fillStyle = "#444444";
    ctx.font = `${it.enPx}px ${FONT_STACK}`;
    ctx.direction = plan.srcRtl ? "rtl" : "ltr";
    ctx.textAlign = plan.srcRtl ? "right" : "left";
    for (const line of it.enLines) {
      ctx.fillText(line, plan.srcRtl ? W - plan.margin : plan.margin, y);
      y += it.enPx * 1.35;
    }
    ctx.fillStyle = "#1F4E79";
    ctx.font = `${it.arPx}px ${FONT_STACK}`;
    ctx.direction = plan.rtl ? "rtl" : "ltr";
    ctx.textAlign = plan.rtl ? "right" : "left";
    for (const line of it.arLines) {
      ctx.fillText(line, plan.rtl ? W - plan.margin : plan.margin, y);
      y += it.arPx * 1.4;
    }
    y += 10 * S;
  }
  return out;
}

function toJpeg(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      async (blob) => {
        if (!blob) return reject(new Error("تعذر تحويل الصفحة لصورة (الذاكرة ممتلئة؟). جرّب جودة أقل."));
        resolve(new Uint8Array(await blob.arrayBuffer()));
      },
      "image/jpeg",
      quality
    );
  });
}


// ------------------------------------------------------------------ OCR (images and scanned pages)

const TESS_URL = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";
const OCR_LANG = { ar: "ara", en: "eng", es: "spa", it: "ita", fr: "fra", de: "deu" };
let tessLoad = null;
let tessWorker = null;
let tessLang = "";

function loadTesseract() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  if (!tessLoad) {
    tessLoad = new Promise((res, rej) => {
      const sc = document.createElement("script");
      sc.src = TESS_URL;
      sc.onload = () => res(window.Tesseract);
      sc.onerror = () => {
        tessLoad = null;
        rej(new Error("تعذر تحميل محرك قراءة الصور (OCR). وصّل النت مرة واحدة وجرّب تاني."));
      };
      document.head.appendChild(sc);
    });
  }
  return tessLoad;
}

async function ocrWorker(code) {
  const T = await loadTesseract();
  if (tessWorker && tessLang === code) return tessWorker;
  if (tessWorker) {
    try {
      await tessWorker.terminate();
    } catch (e) {}
    tessWorker = null;
  }
  const l = OCR_LANG[code];
  tessWorker = await T.createWorker(l, 1, { langPath: `https://cdn.jsdelivr.net/npm/@tesseract.js-data/${l}/4.0.0_best_int` });
  tessLang = code;
  return tessWorker;
}

// words found in the picture -> the same {str, x, y, w, size} items a PDF gives (points, y = baseline)
async function ocrItems(canvas, code, S) {
  const w = await ocrWorker(code);
  const { data } = await w.recognize(canvas);
  const items = [];
  for (const wd of data.words || []) {
    const t = (wd.text || "").trim();
    if (!t || wd.confidence < 30) continue;
    const b = wd.bbox;
    const h = b.y1 - b.y0;
    items.push({ str: t, x: b.x0 / S, w: (b.x1 - b.x0) / S, y: (b.y1 - 0.2 * h) / S, size: Math.max(6, (0.8 * h) / S) });
  }
  return items;
}

async function loadBitmap(file) {
  try {
    return await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch (e) {
    return await new Promise((res, rej) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = () => rej(new Error("المتصفح مش قادر يفتح الصورة دي (جرّب PNG أو JPG)."));
      img.src = url;
    });
  }
}

// ------------------------------------------------------------------ one page

async function processPage(page, opts, onTick) {
  const S = opts.scale;
  const vp1 = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale: S });
  const W = Math.floor(vp.width);
  const H = Math.floor(vp.height);

  const src = document.createElement("canvas");
  src.width = W;
  src.height = H;
  const sctx = src.getContext("2d", { willReadFrequently: true });
  sctx.fillStyle = "#ffffff";
  sctx.fillRect(0, 0, W, H);
  await page.render({ canvasContext: sctx, viewport: vp }).promise;

  const tc = await page.getTextContent();
  let items = [];
  for (const it of tc.items) {
    if (!("str" in it) || !it.str.trim()) continue;
    const tr = it.transform;
    const [x, y] = vp1.convertToViewportPoint(tr[4], tr[5]);
    items.push({ str: it.str, x, y, w: it.width, size: Math.hypot(tr[2], tr[3]) || it.height || 10 });
  }
  let ocred = false;
  if (!items.length) {
    // no text layer: a scanned page, read it as a picture
    try {
      items = await ocrItems(src, opts.src, S);
      ocred = items.length > 0;
    } catch (e) {}
  }
  return finishPage(src, sctx, items, W, H, S, opts, onTick, ocred);
}

async function finishPage(src, sctx, items, W, H, S, opts, onTick, ocred) {
  const paras = paragraphsFromItems(items, ocred && isRtl(opts.src) ? { rtl: true } : {});

  const needed = new Set();
  for (const p of paras) for (const s of sentencesToTranslate(p.text)) needed.add(s);
  const dict = await translateSentences([...needed], opts.src, opts.tgt, onTick);

  const kept = [];
  const arabic = [];
  let failed = 0;
  for (const p of paras) {
    const ar = assembleTranslation(p.text, (s) => dict.get(s) || null);
    if (ar) {
      kept.push(p);
      arabic.push(ar);
    } else failed++;
  }

  let out = src;
  if (kept.length) {
    const common = { W, H, S, paras: kept, arabic, measureFor, arScale: opts.arScale };
    const dirs = { rtl: isRtl(opts.tgt), srcRtl: isRtl(opts.src) };
    const panel = () => Object.assign(planPanel(common), dirs);
    if (opts.mode === "panel") {
      out = composePanel(src, panel(), W, H, S);
    } else {
      const analyzer = makeAnalyzer(sctx.getImageData(0, 0, W, H).data, W, H);
      const plan = Object.assign(planInline({ ...common, analyzer }), dirs);
      if (plan.totalH > H * 3.5 || W * plan.totalH > 15e6) out = composePanel(src, panel(), W, H, S);
      else out = composeInline(src, plan, W, H);
    }
  }

  const jpeg = await toJpeg(out, opts.quality);
  const res = { jpeg, wPx: out.width, hPx: out.height, wPt: out.width / S, hPt: out.height / S, failed };
  if (out !== src) out.width = out.height = 0;
  src.width = src.height = 0;
  return res;
}

// ------------------------------------------------------------------ one file

async function translateFile(file, opts, row) {
  const lib = await loadPdfjs();
  const data = await file.arrayBuffer();
  const pdf = await lib.getDocument({
    data,
    cMapUrl: `${PDFJS_BASE}/cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${PDFJS_BASE}/standard_fonts/`,
  }).promise;

  const pages = [];
  let failed = 0;
  for (let n = 1; n <= pdf.numPages; n++) {
    row.set(((n - 1) / pdf.numPages) * 100, `صفحة ${n} من ${pdf.numPages}`);
    const page = await pdf.getPage(n);
    const r = await processPage(page, opts, (done, total) =>
      row.set(((n - 1) / pdf.numPages) * 100, `صفحة ${n} من ${pdf.numPages} - ترجمة ${done}/${total}`)
    );
    failed += r.failed;
    pages.push(r);
    page.cleanup();
  }
  await pdf.destroy();
  row.set(100, "جاري تجميع الملف...");
  return { bytes: buildPdf(pages), failed };
}


// an image = one page, its text is read with OCR
async function translateImage(file, opts, row) {
  row.set(5, "تحميل الصورة...");
  const bmp = await loadBitmap(file);
  const S = opts.scale;
  const W = Math.round(800 * S);
  const H = Math.max(1, Math.round(((bmp.height || bmp.naturalHeight) * W) / (bmp.width || bmp.naturalWidth)));
  const src = document.createElement("canvas");
  src.width = W;
  src.height = H;
  const sctx = src.getContext("2d", { willReadFrequently: true });
  sctx.fillStyle = "#ffffff";
  sctx.fillRect(0, 0, W, H);
  sctx.drawImage(bmp, 0, 0, W, H);
  if (bmp.close) bmp.close();
  row.set(15, "قراءة النص من الصورة (OCR)...");
  const items = await ocrItems(src, opts.src, S);
  if (!items.length) throw new Error("ماقدرتش أقرا نص في الصورة. اتأكد إن لغة الملف مظبوطة وإن الصورة واضحة.");
  const r = await finishPage(src, sctx, items, W, H, S, opts, (d, t) => row.set(30 + (d / t) * 65, `ترجمة ${d}/${t}`), true);
  row.set(100, "جاري تجميع الملف...");
  return { bytes: buildPdf([r]), failed: r.failed };
}

// ------------------------------------------------------------------ text-like files (txt, docx, html ...)

let mammothLoad = null;
function loadMammoth() {
  if (window.mammoth) return Promise.resolve(window.mammoth);
  if (!mammothLoad) {
    mammothLoad = new Promise((res, rej) => {
      const sc = document.createElement("script");
      sc.src = "https://cdn.jsdelivr.net/npm/mammoth@1.8.0/mammoth.browser.min.js";
      sc.onload = () => res(window.mammoth);
      sc.onerror = () => {
        mammothLoad = null;
        rej(new Error("تعذر تحميل قارئ ملفات Word. وصّل النت مرة واحدة وجرّب تاني."));
      };
      document.head.appendChild(sc);
    });
  }
  return mammothLoad;
}

function htmlToText(html) {
  const t = document.createElement("textarea");
  const txt = html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|blockquote)>|<br\s*\/?>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ");
  t.innerHTML = txt;
  return t.value;
}

async function readTextFile(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith(".docx")) {
    const m = await loadMammoth();
    return (await m.extractRawText({ arrayBuffer: await file.arrayBuffer() })).value;
  }
  let text = await file.text();
  if (/\.html?$/.test(name) || file.type === "text/html") text = htmlToText(text);
  else if (name.endsWith(".srt")) text = text.replace(/^\d+\s*$/gm, "").replace(/^\d\d:\d\d:\d\d[,.]\d+ --> .*$/gm, "");
  // a file that is not really text (binary) is refused
  const bad = (text.slice(0, 2000).match(/[\u0000-\u0008\u000E-\u001F\uFFFD]/g) || []).length;
  if (bad > 20) throw new Error("نوع الملف ده مش مدعوم. المدعوم: PDF، صور، Word (docx)، ونصوص (txt، html، srt، csv...).");
  return text;
}

async function translateDoc(file, opts, row) {
  row.set(3, "قراءة الملف...");
  const raw = await readTextFile(file);
  const paras = raw
    .replace(/\r/g, "")
    .split(/\n\s*\n+/)
    .map((p) => p.replace(/\s*\n\s*/g, " ").replace(/\s+/g, " ").trim())
    .filter((p) => /\p{L}/u.test(p));
  if (!paras.length) throw new Error("مفيش نص في الملف.");

  const needed = new Set();
  for (const p of paras) for (const s of sentencesToTranslate(p)) needed.add(s);
  const dict = await translateSentences([...needed], opts.src, opts.tgt, (d, t) => row.set(5 + (d / t) * 70, `ترجمة ${d}/${t}`));

  // layout: A4 pages, the original paragraph (grey) then its translation (blue)
  const S = opts.scale;
  const W = Math.round(595 * S);
  const H = Math.round(842 * S);
  const M = 40 * S;
  const boxW = W - 2 * M;
  const px = 12 * S;
  const trPx = px * (opts.arScale / 0.9);
  const mSrc = measureFor(px);
  const mTr = measureFor(trPx);
  const sRtl = isRtl(opts.src);
  const tRtl = isRtl(opts.tgt);
  const canvases = [];
  let ctx = null;
  let y = 0;
  const newPage = () => {
    const c = document.createElement("canvas");
    c.width = W;
    c.height = H;
    ctx = c.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, W, H);
    ctx.textBaseline = "top";
    canvases.push(c);
    y = M;
  };
  const drawLines = (lines, size, color, rtl) => {
    ctx.font = `${size}px ${FONT_STACK}`;
    ctx.fillStyle = color;
    for (const line of lines) {
      if (y + size * 1.4 > H - M) {
        newPage();
        ctx.font = `${size}px ${FONT_STACK}`;
        ctx.fillStyle = color;
      }
      ctx.direction = rtl ? "rtl" : "ltr";
      ctx.textAlign = rtl ? "right" : "left";
      ctx.fillText(line, rtl ? W - M : M, y);
      y += size * 1.4;
    }
  };
  newPage();
  let failed = 0;
  for (const p of paras) {
    drawLines(wrapText(p, mSrc, boxW), px, "#555555", sRtl);
    const tr = assembleTranslation(p, (s) => dict.get(s) || null);
    if (tr) drawLines(wrapText(tr, mTr, boxW), trPx, "#1F4E79", tRtl);
    else failed++;
    y += 10 * S;
  }
  const pages = [];
  for (let i = 0; i < canvases.length; i++) {
    row.set(75 + (i / canvases.length) * 20, `صفحة ${i + 1} من ${canvases.length}`);
    pages.push({ jpeg: await toJpeg(canvases[i], opts.quality), wPx: W, hPx: H, wPt: 595, hPt: 842 });
    canvases[i].width = canvases[i].height = 0;
  }
  row.set(100, "جاري تجميع الملف...");
  return { bytes: buildPdf(pages), failed };
}

// picks the right reader for the file
function translateAny(file, opts, row) {
  const n = file.name.toLowerCase();
  if (file.type === "application/pdf" || n.endsWith(".pdf")) return translateFile(file, opts, row);
  if ((file.type || "").startsWith("image/") || /\.(png|jpe?g|webp|bmp|gif|avif)$/.test(n)) return translateImage(file, opts, row);
  return translateDoc(file, opts, row);
}

// ------------------------------------------------------------------ UI

function makeRow(name) {
  const card = document.createElement("div");
  card.className = "card job";
  const n = document.createElement("div");
  n.className = "name";
  n.textContent = name;
  const bar = document.createElement("div");
  bar.className = "bar";
  const fill = document.createElement("i");
  bar.appendChild(fill);
  const st = document.createElement("div");
  st.className = "st";
  st.textContent = "في الانتظار...";
  card.append(n, bar, st);
  $("jobs").prepend(card);
  return {
    card,
    set(pct, text) {
      fill.style.width = Math.max(0, Math.min(100, pct)) + "%";
      st.textContent = text;
      st.className = "st";
    },
    fail(text) {
      st.textContent = text;
      st.className = "st err";
    },
    done(blob, outName, failed) {
      fill.style.width = "100%";
      st.textContent = "تمت الترجمة" + (failed ? ` (${failed} فقرة معرفتش أترجمها)` : "");
      const a = document.createElement("a");
      a.className = "btn ok";
      a.href = URL.createObjectURL(blob);
      a.download = outName;
      a.textContent = "تحميل الملف المترجم";
      card.appendChild(a);
      const file = new File([blob], outName, { type: "application/pdf" });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        const b = document.createElement("button");
        b.className = "btn alt";
        b.textContent = "مشاركة";
        b.onclick = () => navigator.share({ files: [file] }).catch(() => {});
        card.appendChild(b);
      }
    },
  };
}

let chain = Promise.resolve();

function startTranslation() {
  const files = Array.from($("files").files);
  if (!files.length) {
    alert("اختار ملف الأول");
    return;
  }
  const opts = {
    mode: $("mode").value,
    arScale: parseFloat($("size").value),
    scale: parseFloat($("quality").value),
    quality: 0.85,
    src: $("fsrc").value,
    tgt: $("ftgt").value,
  };
  if (opts.src === opts.tgt) {
    alert("اختار لغتين مختلفتين");
    return;
  }
  $("files").value = "";
  for (const file of files) {
    const row = makeRow(file.name);
    chain = chain.then(async () => {
      try {
        row.set(0, "بدأت...");
        const { bytes, failed } = await translateAny(file, opts, row);
        const outName = file.name.replace(/\.[^.]+$/, "") + ` ${opts.tgt}.pdf`;
        row.done(new Blob([bytes], { type: "application/pdf" }), outName, failed);
      } catch (e) {
        row.fail("حدث خطأ: " + ((e && e.message) || e));
      }
    });
  }
}

const PACK_KEY = "mtranslate_packs";
const readPacks = () => {
  try {
    return new Set(JSON.parse(localStorage.getItem(PACK_KEY) || "[]"));
  } catch (e) {
    return new Set();
  }
};

function renderPacks() {
  const have = readPacks();
  const box = $("packs");
  const checked = new Set([...box.querySelectorAll("input:checked")].map((i) => i.value));
  box.textContent = "";
  for (const code of Object.keys(LANGS).filter((c) => c !== "en")) {
    const l = document.createElement("label");
    l.className = "pack";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = code;
    cb.checked = checked.has(code) || (!have.size && code === "ar");
    l.append(cb, document.createTextNode(LANGS[code].name + (have.has(code) ? " ✓" : "")));
    box.appendChild(l);
  }
  setStatus(have.size ? "جاهز بدون نت: " + [...have].map((c) => LANGS[c].name).join("، ") + " ✓" : "اختار الحزم واضغط تحميل (محتاج نت)", have.size ? "ok" : "warn");
}

async function prepareOffline() {
  const btn = $("prepare");
  const chosen = [...$("packs").querySelectorAll("input:checked")].map((i) => i.value);
  if (!chosen.length) return toast("اختار لغة واحدة على الأقل");
  btn.disabled = true;
  try {
    await loadPdfjs();
    const have = readPacks();
    const failed = [];
    for (const code of chosen) {
      let ok = true;
      for (const pair of [[code, "en"], ["en", code]]) {
        fileProgress.clear();
        setStatus(`تحميل حزمة ${LANGS[code].name}...`, "busy");
        try {
          await callWorker({ type: "init", pair });
        } catch (e) {
          ok = false;
          failed.push(((e && e.message) || String(e)).slice(0, 160));
        }
      }
      if (ok) {
        have.add(code);
        localStorage.setItem(PACK_KEY, JSON.stringify([...have]));
      }
    }
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
    renderPacks();
    if (failed.length) setStatus("تعذر تحميل: " + failed.join(" | "), "err");
  } catch (e) {
    setStatus("فشل التجهيز: " + ((e && e.message) || e), "err");
  } finally {
    btn.disabled = false;
  }
}

function fillLangs(id, def) {
  const sel = $(id);
  for (const [code, l] of Object.entries(LANGS)) sel.add(new Option(l.name, code));
  sel.value = def;
}

async function translateText(text, src, tgt, onTick) {
  const lines = text.split("\n").map((l) => sentencesOf(l));
  const need = new Set();
  for (const ss of lines) for (const s of ss) if (/\p{L}/u.test(s)) need.add(s);
  const dict = await translateSentences([...need], src, tgt, onTick);
  let got = 0;
  const out = lines
    .map((ss) =>
      ss
        .map((s) => {
          const r = dict.get(s);
          if (r) got++;
          return r || s;
        })
        .join(" ")
    )
    .join("\n");
  return got ? out : null;
}


const TTS_LANG = { ar: "ar-SA", en: "en-US", es: "es-ES", it: "it-IT", fr: "fr-FR", de: "de-DE" };

function getVoices() {
  return new Promise((res) => {
    const s = window.speechSynthesis;
    const v = s.getVoices();
    if (v.length) return res(v);
    const done = () => res(s.getVoices());
    s.addEventListener("voiceschanged", done, { once: true });
    setTimeout(done, 1200);
  });
}

// speaks with the voices installed on the device (works offline when the voice is a local one)
async function speak(text, code, uri) {
  const s = window.speechSynthesis;
  if (!s || !window.SpeechSynthesisUtterance) return toast("المتصفح ده مش بيدعم النطق");
  text = (text || "").trim();
  if (!text) return;
  s.cancel();
  const voices = await getVoices();
  const mine = voices.filter((v) => v.lang.toLowerCase().replace("_", "-").startsWith(code));
  const offline = !navigator.onLine;
  const pool = offline ? mine.filter((v) => v.localService) : mine;
  const voice = (uri && voices.find((v) => v.voiceURI === uri)) || pool.find((v) => v.localService) || pool[0];
  if (!voice) {
    return toast(
      offline
        ? `مفيش صوت ${LANGS[code].name} متحمّل على الجهاز للنطق بدون نت. ضيفه من إعدادات الصوت في الجهاز.`
        : `مفيش صوت ${LANGS[code].name} على الجهاز. ضيفه من إعدادات الصوت في الجهاز.`
    );
  }
  const u = new SpeechSynthesisUtterance(text);
  u.voice = voice;
  u.lang = voice.lang;
  u.rate = 0.9;
  s.speak(u);
}

// ---- Piper voices (men / women). [id, label, approx size in MB]
const PIPER = {
  ar: [["ar_JO-kareem-medium", "راجل - Kareem", 60], ["ar_JO-kareem-low", "راجل - Kareem (خفيف)", 60]],
  en: [
    ["en_US-hfc_female-medium", "ست - HFC", 60], ["en_US-amy-medium", "ست - Amy", 60], ["en_US-kristin-medium", "ست - Kristin", 60],
    ["en_GB-alba-medium", "ست - Alba (بريطاني)", 60], ["en_US-hfc_male-medium", "راجل - HFC", 60], ["en_US-ryan-medium", "راجل - Ryan", 60],
    ["en_US-joe-medium", "راجل - Joe", 60], ["en_GB-alan-medium", "راجل - Alan (بريطاني)", 60],
  ],
  de: [
    ["de_DE-kerstin-low", "ست - Kerstin", 60], ["de_DE-ramona-low", "ست - Ramona", 60], ["de_DE-eva_k-x_low", "ست - Eva (خفيف)", 20],
    ["de_DE-thorsten-medium", "راجل - Thorsten", 60], ["de_DE-thorsten-high", "راجل - Thorsten (جودة عالية)", 110], ["de_DE-karlsson-low", "راجل - Karlsson", 60],
  ],
  es: [
    ["es_ES-davefx-medium", "راجل - Davefx", 60], ["es_ES-carlfm-x_low", "راجل - Carlfm (خفيف)", 20], ["es_MX-ald-medium", "راجل - Ald (مكسيكي)", 60],
    ["es_MX-claude-high", "Claude (مكسيكي، جودة عالية)", 110],
  ],
  fr: [
    ["fr_FR-siwis-medium", "ست - Siwis", 60], ["fr_FR-siwis-low", "ست - Siwis (خفيف)", 60], ["fr_FR-tom-medium", "راجل - Tom", 60],
    ["fr_FR-gilles-low", "راجل - Gilles", 60],
  ],
  it: [["it_IT-paola-medium", "ست - Paola", 60], ["it_IT-riccardo-x_low", "راجل - Riccardo (خفيف)", 20]],
};

async function storedVoices() {
  const out = new Set();
  try {
    const c = await caches.open("mtranslate-voices");
    for (const req of await c.keys()) if (req.url.endsWith(".onnx")) out.add(decodeURIComponent(req.url.split("/").pop().replace(".onnx", "")));
  } catch (e) {}
  return out;
}

// ---- voices added by the user from an external source (.onnx + .onnx.json, e.g. from the Piper library)
const CUSTOM_HOST = "https://custom.voice.local/";
const safeName = (n) => n.replace(/[^A-Za-z0-9_.-]+/g, "_");

async function importVoices() {
  const files = [...$("cvfiles").files];
  if (!files.length) return toast("اختار ملفي الصوت: .onnx و .onnx.json");
  const groups = new Map();
  for (const f of files) {
    let base, kind;
    if (/\.onnx\.json$/i.test(f.name)) [base, kind] = [f.name.replace(/\.onnx\.json$/i, ""), "json"];
    else if (/\.onnx$/i.test(f.name)) [base, kind] = [f.name.replace(/\.onnx$/i, ""), "onnx"];
    else continue;
    if (!groups.has(base)) groups.set(base, {});
    groups.get(base)[kind] = f;
  }
  if (!groups.size) return toast("الملفات لازم تكون .onnx و .onnx.json");
  const btn = $("cvadd");
  btn.disabled = true;
  const bad = [];
  let added = 0;
  try {
    const cache = await caches.open("mtranslate-voices");
    for (const [base, g] of groups) {
      if (!g.onnx || !g.json) {
        bad.push(base + ": ناقص ملف " + (g.onnx ? ".onnx.json" : ".onnx"));
        continue;
      }
      const jsonText = await g.json.text();
      let cfg;
      try {
        cfg = JSON.parse(jsonText);
        if (!cfg.audio || !cfg.espeak || !cfg.phoneme_id_map) throw 0;
      } catch (e) {
        bad.push(base + ": ملف .json مش بتاع صوت Piper");
        continue;
      }
      const lang = String((cfg.language && cfg.language.family) || cfg.espeak.voice || base).split(/[-_]/)[0].toLowerCase();
      if (!LANGS[lang]) {
        bad.push(base + ": لغته (" + lang + ") مش من اللغات الستة");
        continue;
      }
      const id = "custom~" + lang + "~" + safeName(base);
      await cache.put(new Request(CUSTOM_HOST + id + ".onnx.json"), new Response(jsonText));
      await cache.put(new Request(CUSTOM_HOST + id + ".onnx"), new Response(g.onnx));
      added++;
    }
  } catch (e) {
    bad.push("تعذر التخزين: " + ((e && e.message) || e));
  }
  btn.disabled = false;
  $("cvfiles").value = "";
  refreshVoiceSelects();
  renderCustom();
  const t = $("cvstat");
  if (added) toast(`اتضاف ${added} صوت ✓ اختاره من قايمة «صوت النطق»`);
  t.className = bad.length ? "st err" : "st";
  t.textContent = bad.join(" | ");
}

async function renderCustom() {
  const box = $("cvlist");
  box.textContent = "";
  const mine = [...(await storedVoices())].filter((v) => v.startsWith("custom~"));
  for (const id of mine) {
    const [, lang, ...rest] = id.split("~");
    const row = document.createElement("div");
    row.className = "row";
    const span = document.createElement("span");
    span.style.flex = "1";
    span.textContent = (LANGS[lang] ? LANGS[lang].name : lang) + " - " + rest.join("~");
    const del = document.createElement("button");
    del.className = "alt sq";
    del.style.margin = "4px 0";
    del.textContent = "🗑";
    del.setAttribute("aria-label", "حذف الصوت");
    del.onclick = async () => {
      const c = await caches.open("mtranslate-voices");
      await c.delete(CUSTOM_HOST + id + ".onnx");
      await c.delete(CUSTOM_HOST + id + ".onnx.json");
      if (voicePick(lang) === "piper:" + id) setVoicePick(lang, "");
      renderCustom();
      refreshVoiceSelects();
    };
    row.append(span, del);
    box.appendChild(row);
  }
}

let ttsWorker = null;
let ttsReq = 0;
const ttsPending = new Map();
function getTts() {
  if (ttsWorker) return ttsWorker;
  ttsWorker = new Worker("./tts-worker.js");
  ttsWorker.onmessage = (e) => {
    const m = e.data;
    const p = ttsPending.get(m.id);
    if (!p) return;
    if (m.type === "progress" || m.type === "chunk") return p.onEvent && p.onEvent(m);
    ttsPending.delete(m.id);
    if (m.type === "error") p.reject(new Error(m.error));
    else p.resolve(true);
  };
  ttsWorker.onerror = () => {
    ttsWorker = null;
    for (const p of ttsPending.values()) p.reject(new Error("تعذر تشغيل محرك الأصوات. وصّل النت مرة واحدة وجرّب تاني."));
    ttsPending.clear();
  };
  return ttsWorker;
}
function ttsCall(msg, onEvent) {
  return new Promise((resolve, reject) => {
    const id = ++ttsReq;
    ttsPending.set(id, { resolve, reject, onEvent });
    getTts().postMessage({ ...msg, id });
  });
}

async function piperSpeak(text, voiceId, my) {
  const parts = sentencesOf(text.replace(/\s+/g, " ")).filter((s) => /\p{L}/u.test(s));
  if (!parts.length) return;
  let chain = Promise.resolve();
  if (!(await storedVoices()).has(voiceId)) $("tstat").textContent = "جاري تحميل الصوت (أول مرة بس)...";
  await ttsCall({ type: "speak", voiceId, texts: parts }, (ev) => {
    if (ev.type === "progress") $("tstat").textContent = `تحميل الصوت: ${Math.round((ev.loaded / ev.total) * 100)}%`;
    else {
      $("tstat").textContent = "";
      chain = chain.then(() => (my === speakToken ? playAudio(ev.audio, ev.rate) : null));
    }
  });
  await chain;
  $("tstat").textContent = "";
  refreshVoiceSelects();
}

// ---- Supertonic 3: one multilingual voice model for all 6 languages (men / women), downloaded once (~380 MB)
const SUPER_VOICES = [
  ["F1", "ست 1"], ["F2", "ست 2"], ["F3", "ست 3"], ["F4", "ست 4"], ["F5", "ست 5"],
  ["M1", "راجل 1"], ["M2", "راجل 2"], ["M3", "راجل 3"], ["M4", "راجل 4"], ["M5", "راجل 5"],
];
async function superReady() {
  try {
    const c = await caches.open("mtranslate-supertonic");
    return !!(await c.match("https://supertonic.local/ready"));
  } catch (e) {
    return false;
  }
}
let superWorker = null;
let superReq = 0;
const superPending = new Map();
function getSuper() {
  if (superWorker) return superWorker;
  superWorker = new Worker("./supertonic-worker.js", { type: "module" });
  superWorker.onmessage = (e) => {
    const m = e.data;
    const p = superPending.get(m.id);
    if (!p) return;
    if (m.type === "progress" || m.type === "chunk") return p.onEvent && p.onEvent(m);
    superPending.delete(m.id);
    if (m.type === "error") p.reject(new Error(m.error));
    else p.resolve(true);
  };
  superWorker.onerror = (ev) => {
    superWorker = null;
    const why = (ev && ev.message) || "";
    for (const p of superPending.values()) p.reject(new Error("تعذر تشغيل محرك Supertonic. " + why));
    superPending.clear();
  };
  return superWorker;
}
function superCall(msg, onEvent) {
  return new Promise((resolve, reject) => {
    const id = ++superReq;
    superPending.set(id, { resolve, reject, onEvent });
    getSuper().postMessage({ ...msg, id });
  });
}
// sentences grouped into pieces of up to ~300 characters
function superChunks(text) {
  const out = [];
  let cur = "";
  for (const s of sentencesOf(text.replace(/\s+/g, " ")).filter((x) => /\p{L}/u.test(x))) {
    if (cur && cur.length + s.length + 1 > 300) {
      out.push(cur);
      cur = s;
    } else cur = cur ? cur + " " + s : s;
  }
  if (cur) out.push(cur);
  return out;
}
async function superSpeak(text, code, voice, my) {
  const texts = superChunks(text);
  if (!texts.length) return;
  let chain = Promise.resolve();
  const t = $("tstat");
  if (!(await superReady())) t.textContent = "جاري تحميل صوت Supertonic (أول مرة بس، حوالي 380 ميجا)...";
  await superCall({ type: "speak", voice, lang: code, texts }, (ev) => {
    if (ev.type === "progress") t.textContent = `تحميل الصوت (${ev.n}/${ev.of}): ${Math.round((ev.loaded / ev.total) * 100)}%`;
    else {
      t.textContent = "";
      chain = chain.then(() => (my === speakToken ? playAudio(ev.audio, ev.rate) : null));
    }
  });
  await chain;
  t.textContent = "";
  refreshVoiceSelects();
}

// ---- choosing a device voice (man / woman / any voice installed on the device)
const PICK_KEY = "mtranslate_voice_pick";
const SAMPLE = { ar: "مرحبا", en: "Hello", es: "Hola", it: "Ciao", fr: "Bonjour", de: "Hallo" };
function voicePick(code) {
  try {
    return (JSON.parse(localStorage.getItem(PICK_KEY) || "{}") || {})[code] || "";
  } catch (e) {
    return "";
  }
}
function setVoicePick(code, uri) {
  let m = {};
  try {
    m = JSON.parse(localStorage.getItem(PICK_KEY) || "{}") || {};
  } catch (e) {}
  if (uri) m[code] = uri;
  else delete m[code];
  try {
    localStorage.setItem(PICK_KEY, JSON.stringify(m));
  } catch (e) {}
}
async function fillVoiceSelect(id, code) {
  const sel = $(id);
  const voices = window.speechSynthesis ? await getVoices() : [];
  const offline = !navigator.onLine;
  const list = voices.filter(
    (v) => v.lang.toLowerCase().replace("_", "-").startsWith(code) && (!offline || v.localService)
  );
  const have = await storedVoices();
  const sReady = await superReady();
  const cur = voicePick(code);
  sel.textContent = "";
  sel.add(new Option("تلقائي (صوت التطبيق)", ""));
  const g1 = document.createElement("optgroup");
  g1.label = "أصوات التطبيق (بتشتغل بدون نت بعد التحميل)";
  for (const [vid, label, mb] of PIPER[code] || []) {
    const ok = have.has(vid);
    const o = new Option(ok ? `${label} ✓` : `${label} (تحميل ~${mb} ميجا)`, "piper:" + vid);
    if (!ok && offline) o.disabled = true;
    g1.appendChild(o);
  }
  if (g1.children.length) sel.appendChild(g1);
  const mine = [...have].filter((v) => v.startsWith("custom~") && v.split("~")[1] === code);
  if (mine.length) {
    const g3 = document.createElement("optgroup");
    g3.label = "أصوات أضفتها أنت";
    for (const v of mine) g3.appendChild(new Option(v.split("~").slice(2).join("~") + " ✓", "piper:" + v));
    sel.appendChild(g3);
  }
  const g4 = document.createElement("optgroup");
  g4.label = "Supertonic - كل اللغات (جودة أعلى)";
  for (const [vid, label] of SUPER_VOICES) {
    const o = new Option(sReady ? `${label} ✓` : `${label} (تحميل ~380 ميجا)`, "super:" + vid);
    if (!sReady && offline) o.disabled = true;
    g4.appendChild(o);
  }
  sel.appendChild(g4);
  if (list.length) {
    const g2 = document.createElement("optgroup");
    g2.label = "أصوات الجهاز";
    for (const v of list) g2.appendChild(new Option(v.name + (v.localService ? "" : " (أونلاين)"), v.voiceURI));
    sel.appendChild(g2);
  }
  sel.value = [...sel.options].some((o) => o.value === cur) ? cur : "";
}
function refreshVoiceSelects() {
  fillVoiceSelect("vsrc", $("tsrc").value);
  fillVoiceSelect("vtgt", $("ttgt").value);
}

const VOICE_KEY = "mtranslate_voices";
const readVoices = () => {
  try {
    return new Set(JSON.parse(localStorage.getItem(VOICE_KEY) || "[]"));
  } catch (e) {
    return new Set();
  }
};
const addVoice = (code) => {
  const have = readVoices();
  if (have.has(code)) return;
  have.add(code);
  try {
    localStorage.setItem(VOICE_KEY, JSON.stringify([...have]));
  } catch (e) {}
};

// ---- speech with the downloaded voice models (falls back to the device voices)
let audioCtx = null;
let curSrc = null;
let speakToken = 0;

function getAudioCtx() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  if (!audioCtx) audioCtx = new AC();
  if (audioCtx.state === "suspended") audioCtx.resume();
  return audioCtx;
}

function playAudio(samples, rate) {
  return new Promise((resolve) => {
    const ctx = getAudioCtx();
    if (!ctx) return resolve();
    const buf = ctx.createBuffer(1, samples.length, rate);
    buf.getChannelData(0).set(samples);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.onended = () => {
      if (curSrc === src) curSrc = null;
      resolve();
    };
    curSrc = src;
    src.start();
  });
}

async function speakAny(text, code) {
  text = (text || "").trim();
  if (!text) return;
  const my = ++speakToken;
  $("tstat").className = "st";
  getAudioCtx(); // unlock audio inside the click
  const chosen = voicePick(code);
  if (window.speechSynthesis) window.speechSynthesis.cancel();
  if (curSrc) {
    try {
      curSrc.stop();
    } catch (e) {}
    curSrc = null;
  }
  if (ttsWorker) ttsWorker.postMessage({ type: "cancel", id: ++ttsReq });
  if (superWorker) superWorker.postMessage({ type: "cancel", id: ++superReq });
  if (chosen && (chosen.startsWith("piper:") || chosen.startsWith("super:"))) {
    try {
      if (chosen.startsWith("super:")) return await superSpeak(text, code, chosen.slice(6), my);
      return await piperSpeak(text, chosen.slice(6), my);
    } catch (e) {
      if (my !== speakToken) return;
      // show the REAL reason (not cut) so the problem can be fixed, then use the device voice
      const t = $("tstat");
      t.className = "st err";
      t.textContent = "تعذر تشغيل الصوت المختار: " + ((e && e.message) || e);
      return speak(text, code);
    }
  } else if (chosen) return speak(text, code, chosen);
  const parts = sentencesOf(text.replace(/\s+/g, " ")).filter((s) => /\p{L}/u.test(s));
  try {
    if (!readVoices().has(code)) $("tstat").textContent = "جاري تجهيز الصوت...";
    for (const s of parts) {
      if (my !== speakToken) return;
      const r = await callWorker({ type: "tts", lang: code, text: s });
      if (my !== speakToken) return;
      $("tstat").textContent = "";
      addVoice(code);
      await playAudio(r.audio, r.rate);
    }
    } catch (e) {
    if (my !== speakToken) return;
    $("tstat").textContent = "";
    speak(text, code); // device voice as a fallback
  }
}

function initTextTool() {
  fillLangs("tsrc", "en");
  fillLangs("ttgt", "ar");
  fillLangs("fsrc", "en");
  fillLangs("ftgt", "ar");
  $("tswap").onclick = () => {
    const a = $("tsrc").value;
    $("tsrc").value = $("ttgt").value;
    $("ttgt").value = a;
    if (!$("tout").hidden) $("tin").value = $("tout").textContent;
    $("tout").hidden = $("tcopy").hidden = $("tspk").hidden = true;
    refreshVoiceSelects();
  };
  $("tgo").onclick = async () => {
    const text = $("tin").value.trim();
    const src = $("tsrc").value;
    const tgt = $("ttgt").value;
    if (!text) return;
    if (src === tgt) return toast("اختار لغتين مختلفتين");
    $("tgo").disabled = true;
    $("tstat").className = "st";
    $("tstat").textContent = "جاري الترجمة...";
    try {
      const r = await translateText(text, src, tgt);
      if (!r) throw new Error("معرفتش أترجم النص ده");
      const o = $("tout");
      o.textContent = r;
      o.dir = isRtl(tgt) ? "rtl" : "ltr";
      o.hidden = $("tcopy").hidden = $("tspk").hidden = false;
      o.dataset.lang = tgt;
      $("tstat").textContent = "";
    } catch (e) {
      $("tstat").textContent = "تعذرت الترجمة: " + ((e && e.message) || e) + " (لو مفيش نت لازم تكون حمّلت حزمتي اللغتين).";
    } finally {
      $("tgo").disabled = false;
    }
  };
  $("tcopy").onclick = () =>
    navigator.clipboard.writeText($("tout").textContent).then(() => toast("اتنسخت ✓"), () => toast("تعذر النسخ"));
  $("tspkin").onclick = () => speakAny($("tin").value, $("tsrc").value);
  $("tspk").onclick = () => speakAny($("tout").textContent, $("tout").dataset.lang || $("ttgt").value);
  $("cvadd").onclick = importVoices;
  renderCustom();
  for (const [vid, lid] of [["vsrc", "tsrc"], ["vtgt", "ttgt"]]) {
    $(lid).addEventListener("change", refreshVoiceSelects);
    $(vid).onchange = () => {
      const code = $(lid).value;
      setVoicePick(code, $(vid).value);
      speakAny(SAMPLE[code], code);
    };
  }
  if (window.speechSynthesis) window.speechSynthesis.addEventListener("voiceschanged", refreshVoiceSelects);
  refreshVoiceSelects();
}

function init() {
  if ($("ver")) $("ver").textContent = "نسخة التطبيق: " + APP_VERSION;
  $("go").onclick = startTranslation;
  $("prepare").onclick = prepareOffline;

  let theme = localStorage.getItem("mtranslate_theme") || "auto";
  applyTheme(theme);
  $("theme").onclick = () => {
    theme = theme === "auto" ? "dark" : theme === "dark" ? "light" : "auto";
    localStorage.setItem("mtranslate_theme", theme);
    applyTheme(theme);
  };

  initTextTool();
  renderPacks();

  // app mode: works offline, keeps its data, updates itself
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker
      .register("./sw.js")
      .then((reg) => setInterval(() => reg.update().catch(() => {}), 3600000))
      .catch(() => {});
    navigator.serviceWorker.addEventListener("message", (e) => {
      if (e.data === "updated") toast("في نسخة جديدة جاهزة. اقفل التطبيق وافتحه تاني.");
    });
  }
  window.addEventListener("online", () => toast("رجع النت."));
  window.addEventListener("offline", () => toast("النت قاطع. التطبيق هيكمل شغل عادي لو كنت جهّزته."));

  let deferred = null;
  const installBtn = $("install");
  const isStandalone = () =>
    window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (isStandalone()) installBtn.hidden = true;

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e;
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    installBtn.hidden = true;
    toast("اتثبّت التطبيق ✓");
  });
  installBtn.onclick = async () => {
    if (deferred) {
      deferred.prompt();
      await deferred.userChoice;
      deferred = null;
      return;
    }
    if (isIOS) toast("من زرار المشاركة (Share) اختار «إضافة إلى الشاشة الرئيسية».");
    else toast("لو في قايمة المتصفح (⋮ ← Save and share) خيار «Open in Modather Translate» يبقى التطبيق متثبّت فعلًا، افتحه منه أو من brave://apps. غير كده اختار «Install» أو «Create shortcut».");
  };
}

init();
