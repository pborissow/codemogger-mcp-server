@echo off
setlocal enabledelayedexpansion

REM Index all projects defined in config.json and start the MCP server.
REM Usage:
REM   scripts\index.bat                    Index all + start server on port 8000
REM   scripts\index.bat --index-only       Index only, don't start server
REM   scripts\index.bat my-app my-lib      Index specific projects + start server
REM   scripts\index.bat --port 9000        Use custom port
REM   set MCP_PORT=9000 && scripts\index.bat   Use custom port (env var)

set "SCRIPT_DIR=%~dp0"
set "MCP_DIR=%SCRIPT_DIR%.."
set "CONFIG=%MCP_DIR%\config.json"
if not defined DB_DIR set "DB_DIR=%MCP_DIR%\.codemogger"

if not exist "%DB_DIR%" mkdir "%DB_DIR%"

REM Separate flags from project name arguments
set "INDEX_ONLY=false"
set "SERVER_PORT="
set "PROJECT_ARGS="
set "NEXT_IS_PORT=false"
for %%a in (%*) do (
    if "!NEXT_IS_PORT!"=="true" (
        set "SERVER_PORT=%%a"
        set "NEXT_IS_PORT=false"
    ) else if "%%a"=="--index-only" (
        set "INDEX_ONLY=true"
    ) else if "%%a"=="--port" (
        set "NEXT_IS_PORT=true"
    ) else if "%%a"=="-port" (
        set "NEXT_IS_PORT=true"
    ) else (
        if defined PROJECT_ARGS (
            set "PROJECT_ARGS=!PROJECT_ARGS! %%a"
        ) else (
            set "PROJECT_ARGS=%%a"
        )
    )
)

REM Install dependencies if needed (the indexer uses them too)
if not exist "%MCP_DIR%\node_modules" (
    echo.
    echo === Installing MCP server dependencies ===
    pushd "%MCP_DIR%"
    call npm install
    popd
    REM postinstall applies patches\ via patch-package
)

REM Index through codemogger's patched library (NOT the codemogger CLI, which
REM lacks our chunker patches). Exit codes: 0 ok, 1 a project failed,
REM 2 bad config / unknown project, 3 the MCP server is already running,
REM 4 codemogger not patched (run npx patch-package).
node "%MCP_DIR%\indexer.js" %PROJECT_ARGS%
set "INDEX_RC=%ERRORLEVEL%"
if "%INDEX_RC%"=="4" exit /b 4
if "%INDEX_RC%"=="3" exit /b 3
if "%INDEX_RC%"=="2" exit /b 2
if not "%INDEX_RC%"=="0" (
    echo WARNING: indexing reported failures ^(exit %INDEX_RC%^); see output above.
)

if "%INDEX_ONLY%"=="true" exit /b %INDEX_RC%

echo.
echo === Starting MCP server ===
set "NODE_OPTS=--max-old-space-size=8192 --heapsnapshot-near-heap-limit=2"
if defined SERVER_PORT (
    node %NODE_OPTS% "%MCP_DIR%\server.js" --port %SERVER_PORT%
) else (
    node %NODE_OPTS% "%MCP_DIR%\server.js"
)
