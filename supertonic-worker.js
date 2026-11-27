// supertonic-worker.js - Supertonic 3 text-to-speech (one model, 6 languages, 10 voices) inside the browser.
// Files (~380 MB) are downloaded once into the browser cache and work offline afterwards.
// Messages in : { type:"speak", id, voice:"F1".."M5", lang:"ar|en|es|it|fr|de", texts:[...] }
// Messages out: { type:"progress", id, n, of, loaded, total } | { type:"chunk", id, audio, rate } | { type:"done", id } | { type:"error", id, error }

const ORT_BASES = [
  "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.18.0/dist/",
  "https://unpkg.com/onnxruntime-web@1.18.0/dist/",
];
// the official repo first, mirrors after it. Files are always cached under the FIRST address.
const REPOS = [
  "https://huggingface.co/Supertone/supertonic-3/resolve/main/",
  "https://huggingface.co/jinhwan000/supertonic-3-mirror/resolve/main/",
  "https://huggingface.co/eugenehp/supertonic-3/resolve/main/",
  "https://huggingface.co/OpenVoiceOS/phoonnx-supertonic/resolve/main/",
  "https://hf-mirror.com/Supertone/supertonic-3/resolve/main/",
];
const CACHE = "mtranslate-supertonic";
const READY = "https://supertonic.local/ready";
const FILES = [
  "onnx/tts.json",
  "onnx/unicode_indexer.json",
  "onnx/duration_predictor.onnx",
  "onnx/text_encoder.onnx",
  "onnx/vector_estimator.onnx",
  "onnx/vocoder.onnx",
];
const STEPS = 3; // denoising steps: more = slightly better, slower
const SPEEDS = { slow: 0.75, normal: 0.92, fast: 1.12 }; // normal is a little slower than before

const post = (m, t) => self.postMessage(m, t || []);

let ortP = null;
// same proven way as tts-worker.js (Piper): classic worker, library fetched with CORS then importScripts(blob)
async function importCors(url) {
  const r = await fetch(url, { mode: "cors" });
  if (!r.ok) throw new Error("HTTP " + r.status);
  const blob = URL.createObjectURL(new Blob([await r.text()], { type: "text/javascript" }));
  try {
    importScripts(blob);
  } finally {
    URL.revokeObjectURL(blob);
  }
}
function loadOrt() {
  if (!ortP) {
    ortP = (async () => {
      const errs = [];
      for (const b of ORT_BASES) {
        try {
          await importCors(b + "ort.min.js");
          const ort = self.ort;
          if (!ort || !ort.InferenceSession) throw new Error("ort missing");
          ort.env.wasm.wasmPaths = b;
          ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.max(1, Math.min(4, navigator.hardwareConcurrency || 2)) : 1;
          return ort;
        } catch (e) {
          errs.push(new URL(b).hostname + ": " + ((e && e.message) || e));
        }
      }
      throw new Error("تعذر تحميل محرك الصوت (" + errs.join(" | ") + "). اتأكد من النت وجرّب تاني.");
    })().catch((e) => {
      ortP = null;
      throw e;
    });
  }
  return ortP;
}

async function download(path, jobId, n, of) {
  const cache = await caches.open(CACHE);
  const key = REPOS[0] + path;
  const hit = await cache.match(key);
  if (hit) return hit;
  const errs = [];
  for (const base of REPOS) {
    try {
      const res = await fetch(base + path);
      if (!res.ok) {
        errs.push(new URL(base).hostname + " " + res.status);
        continue;
      }
      const total = +(res.headers.get("Content-Length") || 0);
      const reader = res.body.getReader();
      const parts = [];
      let loaded = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
        loaded += value.length;
        if (total) post({ type: "progress", id: jobId, n, of, loaded, total });
      }
      const out = new Response(new Blob(parts), { headers: { "Content-Type": res.headers.get("Content-Type") || "application/octet-stream" } });
      await cache.put(key, out.clone());
      return out;
    } catch (e) {
      errs.push(new URL(base).hostname + " " + ((e && e.message) || "فشل الاتصال"));
    }
  }
  throw new Error("تعذر تحميل " + path + " (" + errs.join(" | ") + ")");
}

let enginePromise = null; // loaded once, even if "warm" and "speak" ask at the same time
function loadEngine(jobId) {
  if (!enginePromise) {
    enginePromise = loadEngine0(jobId).catch((e) => {
      enginePromise = null;
      throw e;
    });
  }
  return enginePromise;
}
async function loadEngine0(jobId) {
  const ort = await loadOrt();
  const got = [];
  for (let i = 0; i < FILES.length; i++) got.push(await download(FILES[i], jobId, i + 1, FILES.length));
  const cfg = await got[0].json();
  const indexer = await got[1].json();
  const opt = { executionProviders: ["wasm"], graphOptimizationLevel: "all" };
  const mk = async (r) => ort.InferenceSession.create(await r.arrayBuffer(), opt);
  const dp = await mk(got[2]);
  const te = await mk(got[3]);
  const ve = await mk(got[4]);
  const voc = await mk(got[5]);
  const c = await caches.open(CACHE);
  await c.put(READY, new Response("1"));
  return { ort, dp, te, ve, voc, cfg, indexer };
}

const styles = new Map();
async function loadStyle(name, ort, jobId) {
  if (styles.has(name)) return styles.get(name);
  const j = await (await download("voice_styles/" + name + ".json", jobId, 1, 1)).json();
  const t = (o) => new ort.Tensor("float32", Float32Array.from(o.data.flat(Infinity)), o.dims);
  const st = { ttl: t(j.style_ttl), dp: t(j.style_dp) };
  styles.set(name, st);
  return st;
}

// ---- text front-end (no phonemizer: NFKD + unicode index table)
function prep(text, lang) {
  let t = text.normalize("NFKD");
  t = t.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, "");
  t = t
    .replace(/[\u2013\u2011\u2014]/g, "-")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019\u00B4`]/g, "'")
    .replace(/[\[\]|#\u2022]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.!?;:])/g, "$1")
    .trim();
  if (t && !/[.!?;:,'"\u061F\u06D4)\]}\u2026\u3002\u300D\u300F\u3011\u3009\u300B\u203A\u00BB]$/.test(t)) t += ".";
  return `<${lang}>${t}</${lang}>`;
}

function toIds(text, indexer) {
  const ids = [];
  for (const ch of text) {
    const v = indexer[ch.codePointAt(0)];
    if (v !== undefined && v >= 0) ids.push(v);
  }
  return ids;
}

function randn() {
  let u = 0;
  let v = 0;
  while (!u) u = Math.random();
  while (!v) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

async function synth(E, style, text, lang, speed) {
  try {
    return await synth0(E, style, text, lang, speed);
  } catch (e) {
    const names = ["dp", "te", "ve", "voc"].map((k) => k + "[" + (E[k].inputNames || []).join(",") + "]").join(" ");
    throw new Error(((e && e.message) || e) + " | inputs: " + names);
  }
}
async function synth0(E, style, text, lang, speed) {
  const { ort, cfg } = E;
  const ids = toIds(prep(text, lang), E.indexer);
  if (!ids.length) return null;
  const L = ids.length;
  const textIds = new ort.Tensor("int64", BigInt64Array.from(ids, (x) => BigInt(x)), [1, L]);
  const textMask = new ort.Tensor("float32", new Float32Array(L).fill(1), [1, 1, L]);

  const first = (o) => o[Object.keys(o)[0]];
  const dur = first(await E.dp.run({ text_ids: textIds, style_dp: style.dp, text_mask: textMask })).data[0] / speed;
  const textEmb = first(await E.te.run({ text_ids: textIds, style_ttl: style.ttl, text_mask: textMask }));

  const sr = cfg.ae.sample_rate;
  const chunk = cfg.ae.base_chunk_size * cfg.ttl.chunk_compress_factor;
  const latDim = cfg.ttl.latent_dim * cfg.ttl.chunk_compress_factor;
  const wavLen = Math.max(1, Math.floor(dur * sr));
  const latLen = Math.max(1, Math.ceil(wavLen / chunk));
  let xt = new Float32Array(latDim * latLen);
  for (let i = 0; i < xt.length; i++) xt[i] = randn();
  const latMask = new ort.Tensor("float32", new Float32Array(latLen).fill(1), [1, 1, latLen]);
  const total = new ort.Tensor("float32", Float32Array.from([STEPS]), [1]);
  for (let s = 0; s < STEPS; s++) {
    const out = await E.ve.run({
      noisy_latent: new ort.Tensor("float32", xt, [1, latDim, latLen]),
      text_emb: textEmb,
      style_ttl: style.ttl,
      latent_mask: latMask,
      text_mask: textMask,
      current_step: new ort.Tensor("float32", Float32Array.from([s]), [1]),
      total_step: total,
    });
    xt = Float32Array.from(first(out).data);
  }
  const wav = first(await E.voc.run({ latent: new ort.Tensor("float32", xt, [1, latDim, latLen]) })).data;
  return Float32Array.from(wav.subarray(0, Math.min(wav.length, wavLen)));
}

let latest = 0;
self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === "cancel") {
    latest = m.id;
    return;
  }
  if (m.type === "warm") {
    // prepare the model and the voice in the background (does not touch `latest`)
    try {
      const E = await loadEngine(m.id);
      await loadStyle(m.voice || "F1", E.ort, m.id);
      post({ type: "done", id: m.id });
    } catch (err) {
      post({ type: "error", id: m.id, error: "Supertonic: " + String((err && err.message) || err) });
    }
    return;
  }
  latest = m.id;
  try {
    const E = await loadEngine(m.id);
    const style = await loadStyle(m.voice || "F1", E.ort, m.id);
    for (const text of m.texts || []) {
      if (latest !== m.id) break;
      const audio = await synth(E, style, text, m.lang || "en", SPEEDS[m.rate] || SPEEDS.normal);
      if (audio && audio.length) post({ type: "chunk", id: m.id, audio, rate: E.cfg.ae.sample_rate }, [audio.buffer]);
    }
    post({ type: "done", id: m.id });
  } catch (err) {
    post({ type: "error", id: m.id, error: "Supertonic: " + String((err && err.message) || err) });
  }
};
