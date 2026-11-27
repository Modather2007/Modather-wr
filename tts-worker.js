// tts-worker.js - Piper voices (men / women) running inside the browser, no server needed.
// A voice is downloaded once, kept in the browser cache, and works offline afterwards.
// Voices can also be ADDED BY THE USER (files .onnx + .onnx.json from any source): they are stored
// in the same cache under the fake address https://custom.voice.local/<id>.onnx
/* global ort, createPiperPhonemize */

// every library has more than one mirror: if one is blocked or missing, the next one is tried
const ORT_BASES = [
  "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.18.0/dist/",
  "https://unpkg.com/onnxruntime-web@1.18.0/dist/",
];
const PH_BASES = [
  "https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/piper_phonemize",
  "https://unpkg.com/@diffusionstudio/piper-wasm@1.0.0/build/piper_phonemize",
];
// model files: the official Piper library first, a mirror second. Files are always cached under the FIRST address.
const HF_BASES = [
  "https://huggingface.co/rhasspy/piper-voices/resolve/main",
  "https://huggingface.co/diffusionstudio/piper-voices/resolve/main",
];
const CACHE = "mtranslate-voices";
const CUSTOM_HOST = "https://custom.voice.local/";

const post = (m, t) => self.postMessage(m, t || []);

// loads a classic script through fetch (CORS): a failed download is a real error, and the service worker
// can keep a good copy for offline use (importScripts of a cross-origin url gives an opaque answer that can hide errors)
async function importCors(url) {
  const r = await fetch(url, { mode: "cors" });
  if (!r.ok) throw new Error("HTTP " + r.status);
  const code = await r.text();
  const blob = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
  try {
    importScripts(blob);
  } finally {
    URL.revokeObjectURL(blob);
  }
}

let libs = null; // Promise<{ phBase }>
function loadLibs() {
  if (libs) return libs;
  libs = (async () => {
    const errs = [];
    let ortBase = null;
    for (const b of ORT_BASES) {
      try {
        await importCors(b + "ort.min.js");
        ortBase = b;
        break;
      } catch (e) {
        errs.push("onnxruntime: " + new URL(b).hostname);
      }
    }
    if (!ortBase) throw new Error("تعذر تحميل محرك الصوت (" + errs.join("، ") + "). اتأكد من النت وجرّب تاني.");
    ort.env.wasm.wasmPaths = ortBase;
    ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.max(1, Math.min(4, navigator.hardwareConcurrency || 2)) : 1;
    let phBase = null;
    for (const b of PH_BASES) {
      try {
        await importCors(b + ".js");
        phBase = b;
        break;
      } catch (e) {
        errs.push("phonemizer: " + new URL(b).hostname);
      }
    }
    if (!phBase) throw new Error("تعذر تحميل محرك النطق (" + errs.join("، ") + "). اتأكد من النت وجرّب تاني.");
    return { phBase };
  })().catch((e) => {
    libs = null; // let the next try start again
    throw e;
  });
  return libs;
}

const isCustom = (id) => id.startsWith("custom~");

// "de_DE-thorsten-medium" -> "<base>/de/de_DE/thorsten/medium/de_DE-thorsten-medium.onnx"
function urlsOf(id, ext) {
  if (isCustom(id)) return [CUSTOM_HOST + id + (ext === ".json" ? ".onnx.json" : ".onnx")];
  const [loc, name, q] = id.split("-");
  return HF_BASES.map((b) => `${b}/${loc.split("_")[0]}/${loc}/${name}/${q}/${id}.onnx${ext === ".json" ? ".json" : ""}`);
}

async function getFile(urls, id, jobId) {
  const cache = await caches.open(CACHE);
  const key = urls[0];
  const hit = await cache.match(key);
  if (hit) return hit;
  if (isCustom(id)) throw new Error("الصوت المضاف مش موجود على الجهاز. ضيف ملفاته تاني من «إضافة صوت من مصدر خارجي».");
  const errs = [];
  for (const url of urls) {
    try {
      const res = await fetch(url);
      if (!res.ok) {
        errs.push(new URL(url).pathname.split("/")[2] + " → " + res.status);
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
        if (total) post({ type: "progress", id: jobId, voice: id, loaded, total });
      }
      const out = new Response(new Blob(parts), {
        headers: { "Content-Type": res.headers.get("Content-Type") || "application/octet-stream" },
      });
      await cache.put(key, out.clone());
      return out;
    } catch (e) {
      errs.push(new URL(url).hostname + " → " + ((e && e.message) || "فشل الاتصال"));
    }
  }
  throw new Error(
    "تعذر تحميل الصوت " + id + " (" + errs.join(" | ") + "). نزّله يدويًا من مكتبة الأصوات وضيفه من «إضافة صوت من مصدر خارجي»."
  );
}

const sessions = new Map(); // voice id -> Promise<{ session, cfg }>  (the 2 latest voices stay in memory)
function loadVoice(id, jobId) {
  if (sessions.has(id)) {
    const p = sessions.get(id);
    sessions.delete(id);
    sessions.set(id, p);
    return p;
  }
  const p = (async () => {
    const cfg = await (await getFile(urlsOf(id, ".json"), id, jobId)).json();
    const buf = await (await getFile(urlsOf(id, ".onnx"), id, jobId)).arrayBuffer();
    const session = await ort.InferenceSession.create(buf, { executionProviders: ["wasm"] });
    return { session, cfg };
  })().catch((e) => {
    sessions.delete(id);
    throw e;
  });
  sessions.set(id, p);
  while (sessions.size > 2) sessions.delete(sessions.keys().next().value);
  return p;
}

// the phonemizer can run only once per instance, and creating one takes a moment (wasm + data):
// so one spare instance is always prepared in the background and the press of play does not wait for it
let sink = null;
let spare = null;
function newPhonemizer(phBase) {
  return createPiperPhonemize({
    print: (l) => sink && sink.push(l),
    printErr: () => {},
    locateFile: (l) => (l.endsWith(".wasm") ? phBase + ".wasm" : l.endsWith(".data") ? phBase + ".data" : l),
  });
}
function prepareSpare(phBase) {
  if (!spare) spare = newPhonemizer(phBase).catch(() => null);
  return spare;
}
async function phonemize(voice, texts, phBase) {
  let inst = spare ? await spare : null;
  spare = null;
  if (!inst) inst = await newPhonemizer(phBase);
  const outs = [];
  sink = outs;
  inst.callMain(["-l", voice, "--input", JSON.stringify(texts.map((text) => ({ text }))), "--espeak_data", "/espeak-ng-data"]);
  prepareSpare(phBase);
  return outs.map((o) => JSON.parse(o).phoneme_ids);
}

const LENGTH = { slow: 1.4, normal: 1.12, fast: 0.95 }; // multiplies the voice's own length_scale (bigger = slower)
let latest = 0; // a newer job (or a cancel) stops the older one

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === "cancel") {
    latest = m.id;
    return;
  }
  if (m.type === "warm") {
    // get everything ready in the background (does not touch `latest`, so it can never stop a voice that is playing)
    try {
      const { phBase } = await loadLibs();
      await loadVoice(m.voiceId, m.id);
      await prepareSpare(phBase);
      post({ type: "done", id: m.id });
    } catch (err) {
      post({ type: "error", id: m.id, error: String((err && err.message) || err) });
    }
    return;
  }
  latest = m.id;
  try {
    const { phBase } = await loadLibs();
    const { session, cfg } = await loadVoice(m.voiceId, m.id);
    if (m.type === "download") {
      post({ type: "done", id: m.id });
      return;
    }
    const ids = await phonemize(cfg.espeak.voice, m.texts, phBase);
    const inf = cfg.inference;
    const multi = Object.keys(cfg.speaker_id_map || {}).length > 0;
    for (let i = 0; i < ids.length; i++) {
      if (latest !== m.id) break;
      const ph = ids[i];
      if (!ph || !ph.length) continue;
      const feeds = {
        input: new ort.Tensor("int64", BigInt64Array.from(ph, (x) => BigInt(x)), [1, ph.length]),
        input_lengths: new ort.Tensor("int64", BigInt64Array.from([BigInt(ph.length)]), [1]),
        scales: new ort.Tensor("float32", Float32Array.from([inf.noise_scale, inf.length_scale * (LENGTH[m.rate] || LENGTH.normal), inf.noise_w]), [3]),
      };
      if (multi) feeds.sid = new ort.Tensor("int64", BigInt64Array.from([0n]), [1]);
      const res = await session.run(feeds);
      const audio = new Float32Array(res.output.data);
      post({ type: "chunk", id: m.id, audio, rate: cfg.audio.sample_rate }, [audio.buffer]);
    }
    post({ type: "done", id: m.id });
  } catch (err) {
    post({ type: "error", id: m.id, error: String((err && err.message) || err) });
  }
};
