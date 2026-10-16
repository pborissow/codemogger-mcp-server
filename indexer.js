// Index projects from config.json through codemogger's (patched) library.
//
// Usage:
//   node indexer.js                 Index every project in config.json
//   node indexer.js core express    Index only the named projects
//
// Used by scripts/index.sh and scripts/index.bat in place of `npx codemogger
// index`: the codemogger CLI is a standalone bundle that does NOT carry our
// chunker patches, so it would index JavaScript with the unpatched layout.
//
// Refuses to run while the MCP server is up — the server holds these DBs open
// and keeps them current itself (file watcher + chunker-version rebuild), and two
// processes writing one DB is how indexes get corrupted.

import { readFileSync } from "node:fs";
import { createConnection } from "node:net";
import {
  DB_DIR, DB_CONFIGS, SERVER_INFO, CHUNKER_VERSION,
  openIndexes, indexProject, rebuildIfChunkerChanged,
} from "./indexing.js";

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

function portListening(port) {
  return new Promise((resolve) => {
    const s = createConnection({ port, host: "127.0.0.1" });
    s.once("connect", () => { s.destroy(); resolve(true); });
    s.once("error", () => { s.destroy(); resolve(false); });
  });
}

/** The running server's { pid, port }, or null if none (stale file ignored). */
async function runningServer() {
  let info;
  try { info = JSON.parse(readFileSync(SERVER_INFO, "utf-8")); } catch { return null; }
  if (!info?.pid || !pidAlive(info.pid)) return null;
  if (info.port && !(await portListening(info.port))) return null; // pid reused after a crash
  return info;
}

const requested = process.argv.slice(2);
const unknown = requested.filter((p) => !DB_CONFIGS[p]);
if (unknown.length) {
  console.error(`Unknown project(s): ${unknown.join(", ")}`);
  console.error(`Known: ${Object.keys(DB_CONFIGS).join(", ")}`);
  process.exit(2);
}
const projects = requested.length ? requested : Object.keys(DB_CONFIGS);

const server = await runningServer();
if (server) {
  console.error(
    `The MCP server is running (pid ${server.pid}, port ${server.port}) and owns the indexes in ${DB_DIR}.\n` +
    `It keeps them current itself (file watcher + chunker rebuild on restart).\n` +
    `Stop it first if you really need to index from the command line.`
  );
  process.exit(3);
}

const indexes = openIndexes(projects);
let failed = 0;
for (const project of projects) {
  console.log(`\n=== Indexing ${project} (chunker v${CHUNKER_VERSION}) ===`);
  const log = (m) => console.log(`  ${m}`);
  try {
    const rebuilt = await rebuildIfChunkerChanged(project, indexes[project], log);
    if (!rebuilt) await indexProject(project, indexes[project], log);
  } catch (err) {
    failed++;
    console.error(`  failed: ${err.message}`);
  } finally {
    await indexes[project].close();
  }
}
console.log(`\nDone. Indexes stored in ${DB_DIR}`);
process.exit(failed ? 1 : 0);
