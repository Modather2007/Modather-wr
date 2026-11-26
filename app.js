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
const APP_VERSION = "v22";

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

// ---- translation engines: "fast" (opus-mt), "best" (NLLB 600M), "chrome" (the browser's built-in translator)
const ENGINE_KEY = "mtranslate_engine";
const hasChromeTranslator = () => typeof self.Translator !== "undefined" && typeof self.Translator.create === "function";
function currentEngine() {
  const v = ($("engine") && $("engine").value) || "fast";
  return v === "chrome" && !hasChromeTranslator() ? "fast" : v;
}
const chromeTr = new Map();
function chromeGet(a, b) {
  const k = a + ">" + b;
  if (!chromeTr.has(k)) {
    const p = (async () => {
      const av = await self.Translator.availability({ sourceLanguage: a, targetLanguage: b });
      if (av === "unavailable") throw new Error(`المتصفح مش بيدعم الترجمة ${a} ← ${b}`);
      return self.Translator.create({
        sourceLanguage: a,
        targetLanguage: b,
        monitor(m) {
          m.addEventListener("downloadprogress", (e) => setStatus(`تحميل نموذج المتصفح: ${Math.round(e.loaded * 100)}%`, "busy"));
        },
      });
    })();
    p.catch(() => chromeTr.delete(k));
    chromeTr.set(k, p);
  }
  return chromeTr.get(k);
}
async function chromeTranslate(list, src, tgt, onTick) {
  const steps = src === "en" || tgt === "en" ? [[src, tgt]] : [[src, "en"], ["en", tgt]];
  const trs = [];
  for (const [a, b] of steps) trs.push(await chromeGet(a, b));
  const out = [];
  for (let i = 0; i < list.length; i++) {
    let cur = list[i];
    try {
      for (const t of trs) cur = await t.translate(cur);
    } catch (e) {
      cur = null;
    }
    out.push(cur && cur.trim() ? cur : null);
    if (i % 3 === 2 || i === list.length - 1) onTick && onTick(i + 1, list.length);
  }
  return out;
}

// sentences -> Map(sentence -> Arabic or null)
async function translateSentences(list, src, tgt, onTick) {
  const result = new Map();
  const engine = currentEngine();
  // "fast" keeps the old cache keys, the better engines have their own so results are never mixed
  const K = (s) => `${engine === "fast" ? "" : engine + ":"}${src}>${tgt}|${s}`;
  const cached = await cacheGetMany(list.map(K));
  const todo = [];
  for (const s of list) {
    if (cached.has(K(s))) result.set(s, cached.get(K(s)));
    else todo.push(s);
  }
  if (todo.length) {
    const out =
      engine === "chrome"
        ? await chromeTranslate(todo, src, tgt, onTick)
        : await callWorker({ type: "translate", engine, src, tgt, texts: todo }, onTick);
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
// every library has more than one mirror: if one is blocked or down, the next one is tried
const PDFJS_MIRRORS = [
  [PDFJS_BASE + "/build/pdf.min.mjs", PDFJS_BASE + "/build/pdf.worker.min.mjs"],
  [`https://unpkg.com/pdfjs-dist@${PDFJS_VERSION}/build/pdf.min.mjs`, `https://unpkg.com/pdfjs-dist@${PDFJS_VERSION}/build/pdf.worker.min.mjs`],
  [`https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}/pdf.min.mjs`, `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}/pdf.worker.min.mjs`],
];
function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      let last = null;
      for (const [lib, wk] of PDFJS_MIRRORS) {
        try {
          const mod = await import(lib);
          // fetch the worker through the page so the service worker can keep a copy for offline use
          const res = await fetch(wk);
          if (!res.ok) throw new Error("HTTP " + res.status);
          const code = await res.text();
          mod.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
          return mod;
        } catch (e) {
          last = e;
        }
      }
      throw new Error("تعذر تحميل قارئ PDF (" + ((last && last.message) || "فشل الاتصال") + "). وصّل النت مرة واحدة وجرّب تاني.");
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
      const urls = [TESS_URL, "https://unpkg.com/tesseract.js@5.1.1/dist/tesseract.min.js", "https://cdnjs.cloudflare.com/ajax/libs/tesseract.js/5.1.1/tesseract.min.js"];
      const next = (k) => {
        if (k >= urls.length) {
          tessLoad = null;
          return rej(new Error("تعذر تحميل محرك قراءة الصور (OCR). وصّل النت مرة واحدة وجرّب تاني."));
        }
        const sc = document.createElement("script");
        sc.src = urls[k];
        sc.onload = () => res(window.Tesseract);
        sc.onerror = () => next(k + 1);
        document.head.appendChild(sc);
      };
      next(0);
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
  if (opts.wantCanvas) {
    res.canvas = out; // the caller saves it as an image and frees it
    if (out !== src) src.width = src.height = 0;
    return res;
  }
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
  const r = await finishPage(src, sctx, items, W, H, S, { ...opts, wantCanvas: true }, (d, t) => row.set(30 + (d / t) * 65, `ترجمة ${d}/${t}`), true);
  row.set(100, "جاري حفظ الصورة...");
  // the result is saved in the same kind of image that came in (jpg -> jpg, png -> png, webp -> webp)
  const n = file.name.toLowerCase();
  let mime = "image/png";
  let ext = "png";
  if (/\.jpe?g$/.test(n) || file.type === "image/jpeg") [mime, ext] = ["image/jpeg", /\.jpeg$/.test(n) ? "jpeg" : "jpg"];
  else if (/\.webp$/.test(n) || file.type === "image/webp") [mime, ext] = ["image/webp", "webp"];
  const blob = await new Promise((res) => r.canvas.toBlob(res, mime, 0.92));
  r.canvas.width = r.canvas.height = 0;
  if (!blob) throw new Error("تعذر حفظ الصورة (الصورة كبيرة جدًا). جرّب جودة أقل.");
  return { bytes: new Uint8Array(await blob.arrayBuffer()), failed: r.failed, mime, ext };
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

  const pairs = paras.map((p) => ({ src: p, tr: assembleTranslation(p, (x) => dict.get(x) || null) }));
  const failed = pairs.filter((x) => !x.tr).length;
  const n = file.name.toLowerCase();
  row.set(95, "جاري تجميع الملف...");
  if (n.endsWith(".docx")) {
    return { bytes: buildDocx(pairs, isRtl(opts.src), isRtl(opts.tgt)), failed, ext: "docx", mime: DOCX_MIME };
  }
  // text files: the original paragraph, then its translation
  const txt = pairs.map((x) => x.src + (x.tr ? "\n" + x.tr : "")).join("\n\n") + "\n";
  const ext = n.endsWith(".md") ? "md" : "txt";
  return { bytes: new TextEncoder().encode(txt), failed, ext, mime: "text/plain;charset=utf-8" };
}

// ---- a minimal .docx writer (a zip with no compression): original paragraph in grey, translation in blue
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const CRC_T = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();
function crc32(b) {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC_T[(c ^ b[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function zipStore(files) {
  const enc = new TextEncoder();
  const u16 = (v) => [v & 255, (v >> 8) & 255];
  const u32 = (v) => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255];
  const parts = [];
  const central = [];
  let off = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    const head = new Uint8Array([0x50, 0x4b, 3, 4, ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0x21), ...u32(crc), ...u32(f.data.length), ...u32(f.data.length), ...u16(name.length), ...u16(0)]);
    central.push(new Uint8Array([0x50, 0x4b, 1, 2, ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0x21), ...u32(crc), ...u32(f.data.length), ...u32(f.data.length), ...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(off), ...name]));
    parts.push(head, name, f.data);
    off += head.length + name.length + f.data.length;
  }
  const cdSize = central.reduce((a, c) => a + c.length, 0);
  const end = new Uint8Array([0x50, 0x4b, 5, 6, ...u16(0), ...u16(0), ...u16(files.length), ...u16(files.length), ...u32(cdSize), ...u32(off), ...u16(0)]);
  const all = [...parts, ...central, end];
  const out = new Uint8Array(all.reduce((a, c) => a + c.length, 0));
  let p = 0;
  for (const c of all) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}
function buildDocx(pairs, srcRtl, tgtRtl) {
  const esc = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const para = (text, rtl, color, sz, after) =>
    `<w:p><w:pPr>${rtl ? "<w:bidi/>" : ""}<w:spacing w:after="${after}"/></w:pPr><w:r><w:rPr><w:color w:val="${color}"/><w:sz w:val="${sz}"/>${rtl ? "<w:rtl/>" : ""}</w:rPr><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;
  let body = "";
  for (const x of pairs) {
    body += para(x.src, srcRtl, "555555", 22, x.tr ? 40 : 200);
    if (x.tr) body += para(x.tr, tgtRtl, "1F4E79", 24, 200);
  }
  const enc = new TextEncoder();
  const X = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  return zipStore([
    { name: "[Content_Types].xml", data: enc.encode(X + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>') },
    { name: "_rels/.rels", data: enc.encode(X + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>') },
    { name: "word/document.xml", data: enc.encode(X + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' + body + "</w:body></w:document>") },
  ]);
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
      const file = new File([blob], outName, { type: blob.type });
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
        const { bytes, failed, mime = "application/pdf", ext = "pdf" } = await translateAny(file, opts, row);
        const outName = file.name.replace(/\.[^.]+$/, "") + ` ${opts.tgt}.${ext}`;
        row.done(new Blob([bytes], { type: mime }), outName, failed);
      } catch (e) {
        const msg = String((e && e.message) || e);
        row.fail("حدث خطأ: " + (/failed to fetch|networkerror|load failed/i.test(msg) ? "تعذر تحميل مكوّن من النت (قارئ PDF أو نموذج الترجمة). اتأكد من الاتصال وجرّب تاني، ولو بتستخدم VPN أو شبكة بتحجب مواقع فجرّب شبكة تانية. (" + msg + ")" : msg));
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
  const parts = sentencesOf(text.replace(/\s+/g, " ")).filter((x) => /\p{L}/u.test(x));
  for (const part of parts.length ? parts : [text]) {
    const u = new SpeechSynthesisUtterance(part);
    u.voice = voice;
    u.lang = voice.lang;
    u.rate = 0.95;
    s.speak(u);
  }
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

// when no voice was picked by hand: Supertonic (if already downloaded) > best neural/online voice of the device > MMS
async function bestDeviceVoice(code) {
  const s = window.speechSynthesis;
  if (!s || !window.SpeechSynthesisUtterance) return "";
  const vs = (await getVoices()).filter((v) => v.lang.toLowerCase().replace("_", "-").startsWith(code));
  const pool = navigator.onLine ? vs : vs.filter((v) => v.localService);
  const score = (v) =>
    (/natural|neural/i.test(v.name) ? 100 : 0) +
    (/premium|enhanced|siri/i.test(v.name) ? 60 : 0) +
    (/google/i.test(v.name) ? 40 : 0) +
    (/online/i.test(v.name) ? 10 : 0);
  pool.sort((a, b) => score(b) - score(a));
  return pool.length ? pool[0].voiceURI : "";
}
async function autoVoice(code) {
  if (await superReady()) return "super:F1";
  return bestDeviceVoice(code);
}

async function speakAny(text, code) {
  text = (text || "").trim();
  if (!text) return;
  const my = ++speakToken;
  $("tstat").className = "st";
  getAudioCtx(); // unlock audio inside the click
  let chosen = voicePick(code);
  if (!chosen) chosen = await autoVoice(code);
  if (my !== speakToken) return;
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

// ▶ next to a voice list: plays the voice; if it is not on the device yet, offers to download it or to hear it online first
const DEMO_SUPER = "https://huggingface.co/spaces/Supertone/supertonic-3";
const DEMO_PIPER = "https://rhasspy.github.io/piper-samples/";
async function previewVoice(vid, lid) {
  const code = $(lid).value;
  const v = $(vid).value;
  setVoicePick(code, v);
  let demo = "";
  if (v.startsWith("super:") && !(await superReady())) demo = DEMO_SUPER;
  else if (v.startsWith("piper:") && !(await storedVoices()).has(v.slice(6))) demo = DEMO_PIPER;
  if (demo) {
    const ok = confirm(
      "الصوت ده محتاج تحميل قبل ما يشتغل (ممكن يوصل لـ 380 ميجا).\n\nموافق = حمّله دلوقتي واسمعه.\nإلغاء = افتح صفحة عينات أونلاين تسمعه الأول من غير تحميل."
    );
    if (!ok) return void window.open(demo, "_blank", "noopener");
  }
  speakAny(SAMPLE[code], code);
}

function initEngine() {
  const sel = $("engine");
  if (hasChromeTranslator()) sel.querySelector('option[value="chrome"]').hidden = false;
  let saved = "fast";
  try {
    saved = localStorage.getItem(ENGINE_KEY) || "fast";
  } catch (e) {}
  sel.value = [...sel.options].some((o) => o.value === saved && !o.hidden) ? saved : "fast";
  const sync = () => {
    $("prepbest").hidden = sel.value !== "best";
    try {
      localStorage.setItem(ENGINE_KEY, sel.value);
    } catch (e) {}
  };
  sel.onchange = sync;
  sync();
  $("prepbest").onclick = async () => {
    const b = $("prepbest");
    b.disabled = true;
    fileProgress.clear();
    setStatus("تحميل موديل الدقة العالية (كبير، سيب الصفحة مفتوحة)...", "busy");
    try {
      await callWorker({ type: "init", engine: "best" });
      setStatus("موديل الدقة العالية جاهز بدون نت ✓", "ok");
    } catch (e) {
      setStatus("تعذر تحميل الموديل: " + (((e && e.message) || String(e)).slice(0, 200)), "err");
    } finally {
      b.disabled = false;
    }
  };
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
  initEngine();
  renderCustom();
  for (const [vid, lid, pid] of [["vsrc", "tsrc", "pvsrc"], ["vtgt", "ttgt", "pvtgt"]]) {
    $(lid).addEventListener("change", refreshVoiceSelects);
    $(vid).onchange = async () => {
      const code = $(lid).value;
      const v = $(vid).value;
      setVoicePick(code, v);
      // choosing a voice must never start a big download by itself: ▶ asks first
      if (v.startsWith("super:") && !(await superReady())) return toast("الصوت ده لسه متحمّلش. دوس ▶ عشان تسمعه.");
      if (v.startsWith("piper:") && !(await storedVoices()).has(v.slice(6))) return toast("الصوت ده لسه متحمّلش. دوس ▶ عشان تسمعه.");
      speakAny(SAMPLE[code], code);
    };
    $(pid).onclick = () => previewVoice(vid, lid);
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
