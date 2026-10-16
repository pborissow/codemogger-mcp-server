// Shared indexing core used by both server.js (search + auto-reindex) and
// indexer.js (the CLI the launcher scripts call). Keeping one code path matters:
// chunking goes through codemogger's LIBRARY, which carries our patches
// (patches/*.patch). The `codemogger` CLI is a standalone bundle that does NOT,
// so indexing with it would silently produce the unpatched chunk layout.

import { resolve, join, dirname } from "node:path";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CodeIndex } from "codemogger";
import { pipeline } from "@huggingface/transformers";

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- Patch check ---
// Our chunker changes live in patches/codemogger+<version>.patch and are applied
// by patch-package on `npm install` (postinstall). If they're missing — e.g.
// `npm install --ignore-scripts`, or a codemogger upgrade the patch doesn't fit —
// indexing would silently fall back to the unpatched chunk layout, so refuse.
{
  const chunker = join(dirname(fileURLToPath(import.meta.resolve("codemogger"))), "chunk", "treesitter.js");
  let patched = false;
  try { patched = readFileSync(chunker, "utf-8").includes("emitNamespaceClass"); } catch {}
  if (!patched) {
    console.error(
      `codemogger is not patched (${chunker}).\n` +
      `Run \`npx patch-package\` in ${__dirname} (it runs automatically on \`npm install\`\n` +
      `unless scripts are disabled), then try again.`
    );
    process.exit(4);
  }
}

export const DB_DIR = resolve(process.env.DB_DIR || join(__dirname, ".codemogger"));
mkdirSync(DB_DIR, { recursive: true });

// --- Config ---

export const configPath = resolve(process.env.CONFIG_PATH || join(__dirname, "config.json"));
export const config = loadConfig(configPath);

function loadConfig(path) {
  let text;
  try {
    text = readFileSync(path, "utf-8");
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    console.error(
      `No config found at ${path}.\n` +
      `Copy config.example.json to config.json and list the projects you want indexed\n` +
      `(or point CONFIG_PATH at another file).`
    );
    process.exit(2);
  }
  const cfg = JSON.parse(text);
  if (!Array.isArray(cfg.projects) || cfg.projects.length === 0) {
    console.error(`${path} has no "projects" — add at least one (see config.example.json).`);
    process.exit(2);
  }
  return cfg;
}

export const DB_CONFIGS = {};
for (const entry of config.projects) {
  DB_CONFIGS[entry.project] = {
    dbPath: join(DB_DIR, `${entry.project}.db`),
    label: entry.label,
    paths: entry.paths,
  };
}

// --- Local embedder (same model as codemogger's built-in) ---

export const MODEL_NAME = "all-MiniLM-L6-v2";
const MODEL_ID = "Xenova/all-MiniLM-L6-v2";
let _pipe = null;

async function getPipeline() {
  if (!_pipe) {
    _pipe = await pipeline("feature-extraction", MODEL_ID, { dtype: "q8" });
  }
  return _pipe;
}

export async function localEmbed(texts) {
  if (texts.length === 0) return [];
  const pipe = await getPipeline();
  const results = [];
  const BATCH = 128;
  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH);
    const output = await pipe(batch, { pooling: "mean", normalize: true });
    try {
      results.push(...output.tolist());
    } finally {
      // Release the underlying ONNX/WASM tensor — it isn't auto-freed and
      // counts against V8's external-memory limit.
      output.dispose();
    }
  }
  return results;
}

// --- CodeIndex instances (one per project DB) ---

export function openIndexes(projects = Object.keys(DB_CONFIGS)) {
  const indexes = {};
  for (const name of projects) {
    indexes[name] = new CodeIndex({
      dbPath: DB_CONFIGS[name].dbPath,
      embedder: localEmbed,
      embeddingModel: MODEL_NAME,
    });
  }
  return indexes;
}

// --- Per-project async mutex ---
// codemogger's reindex issues FTS DDL (drop/recreate) that can fight a concurrent
// search on the same DB (observed to deadlock/corrupt on macOS). Serialize every op that
// touches a CodeIndex through the project's lock: search never overlaps reindex,
// and two reindexes for one project never overlap either.

const locks = new Map();
export function withLock(key, fn) {
  const prev = locks.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  locks.set(key, run.then(() => {}, () => {})); // tail never rejects
  return run;
}

// --- Indexing ---

/** Incrementally index every configured path of a project. Returns per-dir results. */
export async function indexProject(project, ci, log = console.log) {
  const out = [];
  for (const dir of DB_CONFIGS[project].paths) {
    const r = await withLock(project, () => ci.index(dir));
    log(`${dir} → ${r.files} files, ${r.chunks} chunks (embedded ${r.embedded}, skipped ${r.skipped}, removed ${r.removed}, ${r.duration}ms)` +
      (r.errors?.length ? ` Errors: ${r.errors.join(", ")}` : ""));
    out.push(r);
  }
  return out;
}

// --- Chunker-version rebuild ---
// codemogger skips files whose content hash is unchanged, so a change to our
// chunker patch (patches/codemogger+*.patch) would otherwise only apply to files
// edited afterwards. Each DB records the chunker version it was built with in
// `<project>.chunker`; on mismatch we drop its chunks and re-index through the
// patched library. Bump CHUNKER_VERSION whenever the patch changes chunking.
//   1: namespace-pattern JS chunked as one chunk per constructor
//   2: one chunk per member (this.x / var x / object-literal functions)

export const CHUNKER_VERSION = 2;
const REBUILD_EXT = /\.(js|jsx|mjs|cjs|ts|tsx)$/i; // only the patch's languages need a rebuild

/**
 * If the project's DB was built with an older chunker and contains files the
 * patch affects, drop its chunks and re-index. Returns true if it re-indexed
 * (so callers can skip a redundant incremental pass). Always leaves the marker
 * at the current version.
 */
export async function rebuildIfChunkerChanged(project, ci, log = console.log) {
  const marker = join(DB_DIR, `${project}.chunker`);
  let current = null;
  try { current = parseInt(readFileSync(marker, "utf-8").trim(), 10); } catch {}
  if (current === CHUNKER_VERSION) return false;

  const affected = await withLock(project, async () => {
    const store = await ci.getStore();
    const files = await store.listFiles();
    if (!files.some((f) => REBUILD_EXT.test(f.filePath))) return false; // e.g. Java-only or empty
    log(`chunker v${current ?? "?"} → v${CHUNKER_VERSION}, re-chunking`);
    for (const cb of await store.listCodebases()) {
      await store.removeCodebaseChunks(cb.id);
    }
    return true;
  });
  if (affected) await indexProject(project, ci, log);
  writeFileSync(marker, String(CHUNKER_VERSION));
  return affected;
}

// --- Server liveness file ---
// The server records { pid, port } here while running so the CLI indexer can
// refuse to write a DB the server has open (two writers on one DB).

export const SERVER_INFO = join(DB_DIR, "server.json");
