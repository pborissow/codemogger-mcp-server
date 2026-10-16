import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { join } from "node:path";
import { readFileSync, appendFileSync, writeFileSync, rmSync } from "node:fs";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  StreamableHTTPServerTransport,
} from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { CodemoggerReindexer } from "./watcher.js";
import {
  DB_DIR, configPath, config, DB_CONFIGS, SERVER_INFO,
  openIndexes, withLock, indexProject, rebuildIfChunkerChanged,
} from "./indexing.js";

const portArgIdx = process.argv.findIndex((a) => a === "--port" || a === "-port");
const PORT = portArgIdx !== -1 && process.argv[portArgIdx + 1]
  ? parseInt(process.argv[portArgIdx + 1])
  : parseInt(process.env.MCP_PORT || "8000");
// --- Shared indexing core (config, embedder, CodeIndex, lock, chunker rebuild) ---

const indexes = openIndexes();

// --- Query log ---

const QUERY_LOG = join(DB_DIR, "queries.jsonl");

function logQuery(project, mode, query, resultCount) {
  const entry = JSON.stringify({
    time: new Date().toISOString(),
    project,
    mode,
    query,
    results: resultCount,
  });
  try { appendFileSync(QUERY_LOG, entry + "\n"); } catch {}
}

// --- Auto-reindex on file changes ---

const reindexer = new CodemoggerReindexer({
  debounceMs: 4000,
  reindex: async (project) => {
    if (!DB_CONFIGS[project]) return;
    await indexProject(project, indexes[project], (m) => console.log(`[reindex] ${project}: ${m}`));
  },
});

for (const [name, cfg] of Object.entries(DB_CONFIGS)) {
  reindexer.start(name, cfg.paths);
}

// --- Chunker-version rebuild (background, after listen) ---

async function rebuildAll() {
  for (const project of Object.keys(DB_CONFIGS)) {
    try {
      await rebuildIfChunkerChanged(project, indexes[project], (m) => console.log(`[rebuild] ${project}: ${m}`));
    } catch (err) {
      console.warn(`[rebuild] ${project}: failed: ${err.message}`);
    }
  }
}

// --- MCP server factory ---

function createMcpServer(dbName) {
  const codeIndex = indexes[dbName];
  const config = DB_CONFIGS[dbName];

  const server = new McpServer({
    name: `codemogger-${dbName}`,
    version: "1.0.0",
  });

  server.registerTool("codemogger_search", {
    title: "Search Code Index",
    description: `Search the ${config.label} codebase. Two modes:
- "semantic": natural language queries like "how does authentication work?"
- "keyword": precise identifier lookup like "handleRequest"

Snippets (full source of each match) are included by default and can be large.
Use a small limit (3-5) for semantic queries, or includeSnippet=false to get
file/line locations only.`,
    inputSchema: {
      query: z.string().describe("Search query"),
      mode: z
        .enum(["semantic", "keyword"])
        .default("semantic")
        .describe("semantic for concepts, keyword for identifiers"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .default(10)
        .describe("Max results"),
      includeSnippet: z
        .boolean()
        .default(true)
        .describe("Include full code snippet"),
    },
  }, async ({ query, mode, limit, includeSnippet }) => {
    const results = await withLock(dbName, () => codeIndex.search(query, {
      mode,
      limit,
      includeSnippet,
    }));
    logQuery(dbName, mode, query, results.length);

    if (results.length === 0) {
      const codebases = await codeIndex.listCodebases();
      if (codebases.length === 0) {
        return {
          content: [{
            type: "text",
            text: `No codebases indexed for "${dbName}" yet. The server auto-indexes on startup and watches for file changes; if this persists, check the server log.`,
          }],
        };
      }
      return {
        content: [{
          type: "text",
          text: `No results for "${query}" (${mode}). Indexed: ${codebases.map((c) => c.rootPath).join(", ")}`,
        }],
      };
    }

    const text = results
      .map((r, i) => {
        let entry = `${i + 1}. ${r.filePath}:${r.startLine}-${r.endLine}  [${r.kind}] ${r.name}`;
        if (r.signature) entry += `\n   ${r.signature}`;
        if (r.snippet) entry += `\n\`\`\`\n${r.snippet}\n\`\`\``;
        return entry;
      })
      .join("\n\n");

    return { content: [{ type: "text", text }] };
  });

  // codemogger_index / codemogger_reindex used to live here but the server now
  // watches the configured paths and reindexes on file change (see watcher.js),
  // so a client-triggered reindex is redundant. Manual reindex is still available
  // out-of-band via `scripts\index.bat --index-only` if a rebuild is ever needed.

  return server;
}

// --- HTTP server with per-session MCP transports ---

const app = express();
app.use(express.json());

// Session storage: { [sessionId]: { transport, dbName, lastActivity } }
const sessions = {};
const SESSION_IDLE_MS = 30 * 60 * 1000; // 30 minutes
const SESSION_SWEEP_MS = 5 * 60 * 1000; // sweep every 5 minutes

function touchSession(sid) {
  const s = sessions[sid];
  if (s) s.lastActivity = Date.now();
}

setInterval(() => {
  const cutoff = Date.now() - SESSION_IDLE_MS;
  for (const [sid, s] of Object.entries(sessions)) {
    if (s.lastActivity < cutoff) {
      console.log(`Closing idle session ${sid} (${Math.round((Date.now() - s.lastActivity) / 60000)}m inactive)`);
      s.transport.close().catch(() => {});
      delete sessions[sid];
    }
  }
}, SESSION_SWEEP_MS).unref();

for (const dbName of Object.keys(DB_CONFIGS)) {
  const path = `/${dbName}/mcp`;

  app.post(path, async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];

    if (sessionId && sessions[sessionId]) {
      // Existing session
      touchSession(sessionId);
      await sessions[sessionId].transport.handleRequest(req, res, req.body);
      return;
    }

    if (!sessionId && isInitializeRequest(req.body)) {
      // New session
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          sessions[sid] = { transport, dbName, lastActivity: Date.now() };
        },
      });

      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) delete sessions[sid];
      };

      const server = createMcpServer(dbName);
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Bad Request: invalid or missing session" },
      id: null,
    });
  });

  app.get(path, async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];
    if (!sessionId || !sessions[sessionId]) {
      res.status(400).send("Invalid or missing session ID");
      return;
    }
    touchSession(sessionId);
    await sessions[sessionId].transport.handleRequest(req, res);
  });

  app.delete(path, async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];
    if (sessionId && sessions[sessionId]) {
      await sessions[sessionId].transport.close();
      delete sessions[sessionId];
    }
    res.status(200).end();
  });
}

// CLAUDE.md snippet generator
app.get("/", (_req, res) => {
  const projects = Object.entries(DB_CONFIGS);
  const count = projects.length;

  const serverList = projects
    .map(([name, cfg]) => {
      const scope = cfg.label.includes(" - ")
        ? cfg.label.split(" - ").slice(1).join(" - ")
        : cfg.label;
      const url = `http://localhost:${PORT}/${name}/mcp`;
      return `<li><a href="${url}">${name}</a> &mdash; ${scope}</li>`;
    })
    .join("\n        ");

  const mdTable = projects
    .map(([name, cfg]) => {
      const scope = cfg.label.includes(" - ")
        ? cfg.label.split(" - ").slice(1).join(" - ")
        : cfg.label;
      return `| \`${name}\` | ${scope} |`;
    })
    .join("\n");

  const keywordExamples = config.examples?.keyword?.length
    ? config.examples.keyword.map((e) => `"${e}"`).join(", ")
    : '"handleRequest", "UserService"';
  const semanticExamples = config.examples?.semantic?.length
    ? config.examples.semantic.map((e) => `"${e}"`).join(", ")
    : '"how does authentication work?", "error handling flow"';

  const claudeMd = `# Code Search

${count} Codemogger MCP server${count !== 1 ? "s" : ""} provide${count !== 1 ? "" : "s"} semantic and keyword code search over the codebases listed below. They only cover these codebases, so this repo's own source may not be indexed. When a question is about code in one of them (how a class works, what a method does, how to use a component), use \`codemogger_search\` BEFORE falling back to Grep or Glob.

| MCP Server | Scope |
|------------|-------|
${mdTable}

**Search modes:**
- \`keyword\` — for identifiers, class names, method names (e.g., ${keywordExamples})
- \`semantic\` — for conceptual queries (e.g., ${semanticExamples})

**Result size:** snippets are included by default, and semantic results can be very large (whole classes per result). Keep \`limit\` small (3–5), or pass \`includeSnippet=false\` to get locations only, then Read the relevant lines. Snippets work well for narrow \`keyword\` lookups.

The index auto-refreshes: the MCP server watches each configured path and reindexes on file change (incremental, hash-based), so search results stay current without any client action.`;

  function esc(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <title>Codemogger MCP Server</title>
    <style>
      body { font-family: system-ui, sans-serif; max-width: 720px; margin: 2rem auto; padding: 0 1rem; color: #1a1a1a; }
      h1 { margin-bottom: 0.25rem; }
      p.subtitle { color: #555; margin-top: 0; }
      ul { padding-left: 1.25rem; }
      li { margin: 0.35rem 0; }
      a { color: #0066cc; text-decoration: none; }
      a:hover { text-decoration: underline; }
      h2 { margin-top: 2rem; font-size: 1.1rem; }
      .snippet { position: relative; }
      .snippet pre { background: #f5f5f5; border: 1px solid #ddd; border-radius: 4px; padding: 1rem; padding-top: 1.5rem; overflow-x: auto; font-size: 0.85rem; line-height: 1.5; white-space: pre-wrap; margin: 0; }
      .copy-btn { position: absolute; top: 0.4rem; right: 0.4rem; background: #fff; border: 1px solid #ccc; border-radius: 3px; padding: 0.2rem 0.5rem; font-size: 0.75rem; cursor: pointer; color: #555; }
      .copy-btn:hover { background: #e8e8e8; }
      code { font-family: Consolas, "Liberation Mono", Menlo, monospace; }
      .connect { background: #f0f7ff; border: 1px solid #c0d8f0; border-radius: 4px; padding: 0.75rem 1rem; margin: 1rem 0; }
      .connect code { font-size: 0.85rem; }
    </style>
</head>
<body>
    <h1>Codemogger MCP Server</h1>
    <p class="subtitle">${count} project${count !== 1 ? "s" : ""} available on port ${PORT}</p>

    <h2>MCP Endpoints</h2>
    <ul>
        ${serverList}
    </ul>
    <div class="snippet">
        <button class="copy-btn" onclick="copySnippet(this)">Copy</button>
        <pre>${projects.map(([name]) => `http://localhost:${PORT}/${name}/mcp`).join("\n")}</pre>
    </div>

    <div class="connect">
        Connect with Claude Code:<br>
        <code>claude mcp add &lt;name&gt; --transport streamable-http --url http://localhost:${PORT}/&lt;name&gt;/mcp</code>
    </div>

    <h2>CLAUDE.md Snippet</h2>
    <p>Copy the block below into your project's <code>CLAUDE.md</code>:</p>
    <div class="snippet">
        <button class="copy-btn" onclick="copySnippet(this)">Copy</button>
        <pre>${esc(claudeMd)}</pre>
    </div>
    <script>
    function copySnippet(btn) {
        const text = btn.nextElementSibling.textContent;
        navigator.clipboard.writeText(text).then(() => {
            btn.textContent = 'Copied!';
            setTimeout(() => btn.textContent = 'Copy', 1500);
        });
    }
    </script>
</body>
</html>`;

  res.type("html").send(html);
});

app.post("/", (_req, res) => {
  const endpoints = Object.keys(DB_CONFIGS).map(
    (name) => `http://localhost:${PORT}/${name}/mcp`
  );
  res.status(404).json({
    jsonrpc: "2.0",
    error: {
      code: -32000,
      message: "No MCP endpoint at /. Use a project-specific path.",
      data: { endpoints },
    },
    id: null,
  });
});

// Health check
app.get("/health", (_req, res) => {
  const mem = process.memoryUsage();
  res.json({
    status: "ok",
    databases: Object.fromEntries(
      Object.entries(DB_CONFIGS).map(([name, dbConfig]) => [
        name,
        { path: dbConfig.dbPath, label: dbConfig.label, paths: dbConfig.paths },
      ])
    ),
    sessions: Object.keys(sessions).length,
    sessionsByDb: Object.values(sessions).reduce((acc, s) => {
      acc[s.dbName] = (acc[s.dbName] || 0) + 1;
      return acc;
    }, {}),
    watcher: reindexer.status(),
    memoryMB: {
      rss: Math.round(mem.rss / 1024 / 1024),
      heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
      external: Math.round(mem.external / 1024 / 1024),
    },
  });
});

function checkPort(port) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ port, host: "127.0.0.1" });
    socket.once("connect", () => {
      socket.destroy();
      reject(new Error(`Port ${port} is already in use. Stop the other process or set MCP_PORT to a different port.`));
    });
    socket.once("error", (err) => {
      socket.destroy();
      if (err.code === "ECONNREFUSED") resolve();
      else reject(err);
    });
  });
}

checkPort(PORT).then(() => {
  const server = app.listen(PORT, () => {
    console.log(`Codemogger MCP server listening on http://localhost:${PORT}`);
    console.log(`Config: ${configPath}`);
    console.log(`Databases: ${DB_DIR}`);
    console.log(`Projects (${Object.keys(DB_CONFIGS).length}):`);
    for (const [name, cfg] of Object.entries(DB_CONFIGS)) {
      console.log(`  ${name}: http://localhost:${PORT}/${name}/mcp`);
      for (const p of cfg.paths) {
        console.log(`    - ${p}`);
      }
    }
    // Tell the CLI indexer we own these DBs (it refuses to write while we're up).
    try { writeFileSync(SERVER_INFO, JSON.stringify({ pid: process.pid, port: PORT })); } catch {}
    void rebuildAll(); // background; searches queue behind it via the per-project lock
  });

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(`Port ${PORT} is already in use. Stop the other process or set MCP_PORT to a different port.`);
    } else {
      console.error("Server failed to start:", err.message);
    }
    process.exit(1);
  });
}).catch((err) => {
  console.error(err.message);
  process.exit(1);
});

process.on("SIGINT", async () => {
  reindexer.stopAll();
  for (const sid of Object.keys(sessions)) {
    await sessions[sid].transport.close();
  }
  for (const idx of Object.values(indexes)) {
    await idx.close();
  }
  process.exit(0);
});

// Remove the liveness file on any exit we get to see. (A hard crash can leave it
// behind; the indexer double-checks the pid AND the port before trusting it.)
process.on("exit", () => {
  try {
    const info = JSON.parse(readFileSync(SERVER_INFO, "utf-8"));
    if (info.pid === process.pid) rmSync(SERVER_INFO, { force: true });
  } catch {}
});
