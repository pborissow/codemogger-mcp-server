import fs from "node:fs";
import { existsSync } from "node:fs";
import { extname } from "node:path";

/**
 * Auto-reindex codemogger's index when watched source directories change.
 *
 * codemogger's `CodeIndex.index()` is incremental and content-hashed, so re-running
 * it after every save is cheap — the point of the debounce is to coalesce a burst
 * of saves (formatter-on-save, "Save All", git checkout) into ONE reindex, and the
 * single-flight guard is to make sure a slow reindex never has a second one racing
 * behind it and mutating the FTS index concurrently.
 *
 * PLATFORM: `fs.watch({ recursive: true })` is macOS/Windows only. On Linux it
 * throws ERR_FEATURE_UNAVAILABLE_ON_PLATFORM; `start()` no-ops there with one
 * warning. Cross-platform recursive watching would need chokidar — deferred until
 * we actually need Linux.
 */

/** Directories whose events never warrant a reindex (build output, VCS, deps). */
const IGNORE_DIRS = new Set([
  "node_modules", ".git", ".next", ".turbo", ".cache", ".svelte-kit",
  "dist", "build", "out", "coverage", ".codemogger", ".vercel", "target",
]);

/** File extensions codemogger indexes (its tree-sitter language set). */
const INDEX_EXT = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".go", ".java", ".rs", ".rb", ".php", ".scala", ".cs", ".zig",
  ".c", ".h", ".cc", ".cpp", ".hpp", ".cxx", ".hh",
]);

const RECURSIVE_WATCH_SUPPORTED =
  process.platform === "win32" || process.platform === "darwin";

/**
 * Should a change to `filename` (as fs.watch reports it, relative to the watched
 * root) trigger a reindex? True only for an indexable source extension that isn't
 * under an ignored directory. Exported for testability.
 */
export function isIndexableChange(filename) {
  if (!filename) return false;
  const segments = String(filename).replace(/\\/g, "/").split("/");
  for (const seg of segments) if (IGNORE_DIRS.has(seg)) return false;
  return INDEX_EXT.has(extname(String(filename)).toLowerCase());
}

export class CodemoggerReindexer {
  constructor({ debounceMs = 4000, reindex } = {}) {
    if (typeof reindex !== "function") {
      throw new Error("CodemoggerReindexer: `reindex` function is required");
    }
    this.debounceMs = debounceMs;
    this.reindex = reindex; // async (projectName) => void
    this.watchers = new Map();   // project -> FSWatcher[]
    this.debounces = new Map();  // project -> Timeout
    this.running = new Set();    // project names currently reindexing
    this.dirty = new Set();      // project names with edits during a reindex
    this.unsupportedWarned = false;
  }

  /** Start watching `dirs` for `project`. Idempotent; skips missing dirs. */
  start(project, dirs) {
    if (!project) return;
    if (!RECURSIVE_WATCH_SUPPORTED) {
      if (!this.unsupportedWarned) {
        this.unsupportedWarned = true;
        console.log(
          `[watch] auto-reindex unavailable (recursive fs.watch is macOS/Windows only; platform=${process.platform})`
        );
      }
      return;
    }
    if (this.watchers.has(project)) return; // already watching
    const existing = dirs.filter((d) => existsSync(d));
    if (!existing.length) {
      console.warn(`[watch] ${project}: no existing dirs to watch`);
      return;
    }
    const watchers = [];
    for (const dir of existing) {
      try {
        const w = fs.watch(dir, { recursive: true }, (_evt, filename) => {
          if (isIndexableChange(filename)) this.schedule(project);
        });
        w.on("error", (err) => {
          try { w.close(); } catch { /* ignore */ }
          const arr = this.watchers.get(project);
          if (arr) {
            const i = arr.indexOf(w);
            if (i >= 0) arr.splice(i, 1);
            if (!arr.length) this.watchers.delete(project);
          }
          console.warn(`[watch] ${project}: watcher error on ${dir}: ${err.message}`);
        });
        watchers.push(w);
      } catch (err) {
        console.warn(`[watch] ${project}: failed to watch ${dir}: ${err.message}`);
      }
    }
    if (!watchers.length) return;
    this.watchers.set(project, watchers);
    console.log(`[watch] ${project}: watching ${existing.length} dir(s)`);
  }

  /** Debounce a reindex for `project`. */
  schedule(project) {
    const existing = this.debounces.get(project);
    if (existing) clearTimeout(existing);
    this.debounces.set(
      project,
      setTimeout(() => {
        this.debounces.delete(project);
        void this.run(project);
      }, this.debounceMs)
    );
  }

  /** Run a reindex, single-flight per project. */
  async run(project) {
    if (this.running.has(project)) {
      this.dirty.add(project);
      return;
    }
    this.running.add(project);
    try {
      await this.reindex(project);
    } catch (err) {
      console.warn(`[watch] ${project}: reindex failed: ${err.message}`);
    } finally {
      this.running.delete(project);
      if (this.dirty.delete(project)) this.schedule(project);
    }
  }

  /** Introspection for /health. */
  status() {
    return {
      watching: [...this.watchers.keys()],
      pending: [...this.debounces.keys()],
      running: [...this.running],
    };
  }

  /** Tear down every watcher + pending debounce. Call on shutdown. */
  stopAll() {
    for (const ws of this.watchers.values()) {
      for (const w of ws) { try { w.close(); } catch { /* ignore */ } }
    }
    this.watchers.clear();
    for (const t of this.debounces.values()) clearTimeout(t);
    this.debounces.clear();
    this.dirty.clear();
  }
}
