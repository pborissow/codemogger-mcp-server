# Codemogger MCP Server

A shared HTTP server that exposes [Codemogger](https://github.com/glommer/codemogger) code
indexes as [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) tools.
Multiple Claude Code sessions can connect concurrently to search across all indexed projects.

## How It Works

1. Source code is parsed with [tree-sitter](https://tree-sitter.github.io/) into semantic chunks (functions, classes, structs)
2. Chunks are embedded locally using [all-MiniLM-L6-v2](https://huggingface.co/Xenova/all-MiniLM-L6-v2) (quantized, runs on CPU)
3. Embeddings are stored in SQLite databases (one `.db` file per project) via [Turso](https://turso.tech/)
4. The HTTP server exposes each project as a separate MCP endpoint
5. Claude Code connects to whichever project endpoints it needs
6. The server watches each project's configured paths and re-indexes on file change (incremental, hash-based) — the index stays fresh with no client action

```
config.json ──► index.sh/bat ──► .codemogger/*.db ◄── auto-reindex on file change
                                       │                        ▲
                                  server.js ────► fs.watch ─────┘
                                       │
                          ┌────────────┼────────────┐
                     /app/mcp    /api/mcp    /shared/mcp  ...
                          │            │            │
                     Claude Code sessions (concurrent)
```

No data leaves the machine — all embedding and search runs locally.

## Prerequisites

- [Node.js](https://nodejs.org/) 18+
- npm

## Quick Start

```bash
# Install dependencies (postinstall applies the local codemogger patch)
npm install

# Create your config (machine-specific; not committed) and list your projects
cp config.example.json config.json

# Index all projects and start the server
./scripts/index.sh          # Linux/macOS/Git Bash
scripts\index.bat           # Windows CMD
```

The server starts on port 8000 by default. Each project gets an MCP endpoint at `http://localhost:8000/<project>/mcp`.

## Connecting Claude Code

Add MCP server entries for the projects you want available in a given Claude Code session. For example, to connect a project called `my-app`:

```bash
claude mcp add my-app --transport streamable-http --url http://localhost:8000/my-app/mcp
```

Verify the connection:

```bash
claude mcp list
```

Or use the `/mcp` command inside Claude Code to check connection status.

## Configuration

All projects are defined in `config.json`. It holds machine-specific paths, so it's git-ignored (as are variations like `config - Copy.json`). Start from the tracked `config.example.json`:

```json
{
  "projects": [
    {
      "project": "my-app",
      "label": "My App - Web application backend and frontend",
      "paths": [
        "/home/user/projects/my-app/src",
        "/home/user/projects/my-app/lib"
      ]
    }
  ]
}
```

| Field     | Description |
|-----------|-------------|
| `project` | Short name used in the URL path and `.db` filename |
| `label`   | Human-readable description shown in tool descriptions |
| `paths`   | Array of directories to index (multiple paths share one database) |

**Adding a project:** Add an entry to `config.json` and re-run `scripts/index.sh` / `scripts\index.bat`. That indexes the new project's paths, then starts (or restarts) the server so the auto-reindex watcher attaches to them.

**Removing a project:** Remove the entry from `config.json`, restart the server, and optionally delete the `.db` file from `.codemogger/`.

## Scripts

### `scripts/index.sh` (Linux/macOS/Git Bash)

```bash
./scripts/index.sh                    # Index all projects + start server
./scripts/index.sh --index-only       # Index only, don't start server
./scripts/index.sh my-app my-lib      # Index specific projects + start server
./scripts/index.sh --port 9000        # Use custom port
MCP_PORT=9000 ./scripts/index.sh      # Use custom port (env var)
```

### `scripts/index.bat` (Windows CMD)

```
scripts\index.bat                              Index all + start server
scripts\index.bat --index-only                 Index only
scripts\index.bat my-app my-lib                Index specific projects + start server
scripts\index.bat --port 9000                  Use custom port
set MCP_PORT=9000 && scripts\index.bat         Use custom port (env var)
```

### How the scripts index

Both scripts call `node indexer.js [project ...]`, which indexes through codemogger's **library** (via `indexing.js`, the same code path the server uses). They deliberately do **not** use `npx codemogger index`: the codemogger CLI is a standalone bundle that doesn't carry our chunker patches, so it would index JavaScript with the old one-chunk-per-class layout.

The indexer also applies the [chunker-version rebuild](#auto-reindex) before its incremental pass, and it **refuses to run while the MCP server is up** (exit code 3). The server owns the DBs and keeps them current itself, and two processes writing one DB risks corruption. The server records its `{ pid, port }` in `.codemogger/server.json`. The indexer trusts that file only if the pid is alive *and* the port is listening, so a stale file left by a crash doesn't block it.

| Exit code | Meaning |
|-----------|---------|
| 0 | Success |
| 1 | One or more projects failed (the full script still starts the server) |
| 2 | Missing/empty `config.json`, or unknown project name |
| 3 | MCP server already running — nothing indexed |
| 4 | codemogger isn't patched — run `npx patch-package` (see [the local patch](#namespace-pattern-javascript-local-patch)) |

### Port selection

The server port is determined by (in order of priority):

1. `--port` / `-port` CLI argument
2. `MCP_PORT` environment variable
3. Default: `8000`

The server will refuse to start if the port is already in use.

## MCP Tools

Each project endpoint exposes one tool. Indexing is not a tool — the server owns it (see [Auto-Reindex](#auto-reindex) below).

### `codemogger_search`

Search the project's code index.

| Parameter        | Type    | Default    | Description |
|------------------|---------|------------|-------------|
| `query`          | string  | (required) | Search query |
| `mode`           | string  | `semantic` | `semantic` for natural language, `keyword` for identifiers |
| `limit`          | integer | `10`       | Max results (1-50) |
| `includeSnippet` | boolean | `true`     | Include full source code in results |

**Semantic mode** — natural language queries like "how does authentication work?" or "error handling middleware". Uses vector similarity against chunk embeddings.

**Keyword mode** — precise identifier lookup like "UserService" or "handleRequest". Uses full-text search. Significantly faster than semantic search.

## Auto-Reindex

The server attaches a native `fs.watch({ recursive: true })` to each project's configured paths on startup. When any indexable source file changes:

1. Non-source events are filtered out (see below).
2. A 4-second debounce coalesces bursts of saves (formatter-on-save, "Save All", `git checkout`) into one reindex.
3. Single-flight per project — a second reindex never races a running one; edits during a reindex are captured via a dirty flag and re-run once.
4. `codemogger.index()` itself is incremental and content-hashed, so unchanged files are a no-op.

**Filters** — only paths under the watched roots with these extensions trigger a reindex:

`.ts .tsx .js .jsx .mjs .cjs .py .go .java .rs .rb .php .scala .cs .zig .c .h .cc .cpp .hpp .cxx .hh`

Events under `node_modules`, `.git`, `.next`, `.turbo`, `.cache`, `.svelte-kit`, `dist`, `build`, `out`, `coverage`, `.codemogger`, `.vercel`, and `target` are ignored.

**Platform** — recursive `fs.watch` is macOS/Windows only. On Linux the watcher logs one warning and no-ops; you can still trigger a rebuild with `scripts/index.sh --index-only`. Adding chokidar for cross-platform recursive watching is a straightforward follow-up if Linux support is needed.

**Concurrency** — a per-project async mutex serializes every `CodeIndex` operation for a given database, so a reindex's FTS DDL never fights a concurrent search on the same DB.

Watcher state is visible in `GET /health` under `watcher: { watching, pending, running }`.

**Chunker-version rebuild** — because unchanged files are skipped by hash, a change to the chunker patch wouldn't otherwise reach existing files. Each DB records the chunker version it was built with in `.codemogger/<project>.chunker`. On startup, any DB containing JS/TS files whose marker doesn't match `CHUNKER_VERSION` in `server.js` has its chunks dropped and is re-indexed in the background through the patched library. Searches against that project wait behind the per-project lock until the rebuild finishes. DBs without JS/TS files (e.g. Java-only) just get the marker written. **Bump `CHUNKER_VERSION` in `indexing.js` whenever the codemogger patch changes chunking.**

## Environment Variables

| Variable      | Default                  | Description |
|---------------|--------------------------|-------------|
| `MCP_PORT`    | `8000`                   | HTTP server port (overridden by `--port` CLI arg) |
| `CONFIG_PATH` | `./config.json`          | Path to project configuration file |
| `DB_DIR`      | `./.codemogger`          | Directory for SQLite database files |

## Endpoints

| Endpoint                  | Description |
|---------------------------|-------------|
| `POST /<project>/mcp`    | MCP protocol (initialize or send messages) |
| `GET /<project>/mcp`     | MCP protocol (SSE streaming for active sessions) |
| `DELETE /<project>/mcp`  | Close an MCP session |
| `GET /health`            | Server health check — project list, active sessions (total and per DB), watcher state (`watching` / `pending` / `running`), and live memory stats (`rss`, `heapUsed`, `heapTotal`, `external`, all in MB) |

## Architecture

- **Express 5** HTTP server with per-session MCP transports
- **Streamable HTTP** transport (not SSE-only) per the MCP spec
- **One `CodeIndex` instance per project**, shared across all sessions connecting to that project
- **One embedding pipeline** (`@huggingface/transformers`) shared across all projects — loaded lazily on first search/index call. ONNX tensors are `.dispose()`-d after each batch so external memory doesn't leak.
- **Per-project async mutex** — every `CodeIndex.search()` and `CodeIndex.index()` for a given DB goes through one lock chain, so a reindex's FTS DDL never overlaps a search and two reindexes never overlap
- **File watcher** — `watcher.js` attaches recursive `fs.watch` to each project's paths and drives incremental reindexes (see [Auto-Reindex](#auto-reindex))
- **Session isolation** — each Claude Code connection gets its own MCP session with independent state, but shares the underlying index
- **Idle session sweep** — sessions with no activity for 30 minutes are closed and dropped every 5 minutes (guards against clients that disconnect without sending `DELETE`)
- **Memory tuning** — the launcher scripts start Node with `--max-old-space-size=8192` and `--heapsnapshot-near-heap-limit=2`, so the 4 GB V8 default doesn't clip long-running sessions and a heap snapshot is dumped automatically if the limit is ever approached

## Supported Languages

Codemogger uses tree-sitter for AST-aware chunking. Supported languages:

Rust, C, C++, Go, Python, Zig, Java, Scala, JavaScript, TypeScript, TSX, PHP, Ruby

Non-code files (`.md`, `.json`, `.yaml`, `.html`, `.css`) are **not indexed**. Comments and docs attached to a function/class definition are included in that chunk's text and are searchable.

### Namespace-pattern JavaScript (local patch)

Codemogger's tree-sitter chunker only recognizes standard declarations (`function foo()`, `class Foo`, `const foo = ...`). JavaScript that uses namespace-assignment patterns like:

```javascript
Namespace.ClassName = function(parent, config) { ... }
```

produces `expression_statement > assignment_expression` in the AST, which codemogger skips by default.

A local patch, `patches/codemogger+0.1.2.patch`, adds support for this pattern. It modifies two files in `node_modules/codemogger/dist/chunk/`:

- **`languages.js`** — adds `"expression_statement"` to the JavaScript `topLevelNodes` array
- **`treesitter.js`** — handles namespace assignments in `processNode()`:
  - `Namespace.Class = function(...) {...}` → a slim **class header** chunk (doc comment + setup code up to the first member), plus **one chunk per member** defined directly in the constructor body: `this.foo = function` (kind `method`), and `var foo = function` / `function foo()` (kind `function`). Members are named `Namespace.Class.foo`.
  - `Namespace.utils = { foo: function(){...}, ... }` → a small **namespace** header chunk plus one `function` chunk per function-valued property (`Namespace.utils.foo`). Objects with no function members are skipped.
  - `Namespace.X = class {...}` → one `class` chunk (unchanged).
  - Each member chunk includes its preceding `/** ... */` doc comment, which matters because codemogger only embeds the first 500 characters of a chunk.

Keyword search only matches chunk `name` and `signature`, so per-member chunks are what make keyword lookups of method names (e.g. `getValue`, `addItem`) work. Known limitation: a long function with no doc comment is hard to find semantically when the relevant code sits past its first 500 characters. Use keyword search on its name, or Grep.

This patch only affects codemogger's library API, which both the server and `indexer.js` use. The `codemogger` CLI binary (`dist/cli.mjs`) is a standalone bundle and is **not** affected, which is why the scripts no longer call it.

**How it's applied** — with [patch-package](https://github.com/ds300/patch-package), from the `postinstall` script, on every `npm install`. It's pure Node, so it works on Windows without bash or `patch`. codemogger is pinned to exactly `0.1.2` in `package.json` because the patch is written against that version.

If the patch isn't applied (e.g. `npm install --ignore-scripts`), the server and indexer refuse to start (exit code 4) rather than silently indexing with the unpatched layout. Fix with:

```bash
npx patch-package
```

**Changing the patch** — edit the files under `node_modules/codemogger/dist/chunk/`, then regenerate the patch and bump `CHUNKER_VERSION` in `indexing.js` so existing indexes get re-chunked:

```bash
npx patch-package codemogger
```

**Upgrading codemogger** — bump the pinned version, `npm install`, and resolve any patch-package failure by re-applying the changes by hand and regenerating the patch. Remove the old `codemogger+<old-version>.patch`.
