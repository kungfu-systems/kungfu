@echo off
rem shifu.cmd - kungfu dev/build launcher (Windows).
rem ASCII-only on purpose: Windows cmd parses .cmd in the OEM codepage (e.g. GBK/936),
rem so non-ASCII bytes corrupt parsing. Keep this file ASCII; the sh version may use UTF-8.
rem
rem == PROTOCOL WARNING (ADR-0044) ==============================================
rem This file's NAME and LOCATION (repo root) are a welded surface baked into
rem every installed shifu binary in the wild: together with ./shifu it is how
rem they recognize a checkout and what they spawn (via cmd.exe) when
rem delegating. Never rename, move, or remove it. Its implementation may
rem change freely, but any dispatch of a resolved native binary must keep
rem setting SHIFU_FROM_SHIM=1.
rem See framework/core/docs/adr/ADR-0044-shifu-delegation-protocol.md
rem =============================================================================
rem
rem Aligns with the macOS/Linux shifu (sh):
rem   shifu app | shifu build:core | shifu <any pnpm task>
rem   shifu cache / proxy / config   rich subcommands -> delegated to L2 node (not pnpm)
rem
rem This script is a thin shim in front of the native launcher (crates\shifu,
rem a self-contained Rust binary -- see docs/rust-adoption.md). Resolution order:
rem   1. SHIFU_BIN            explicit binary override
rem   2. dev machines (cargo + git) -> source-fresh cache slot
rem                                    ...\kungfu\shifu\<version>-<launcher-src-sha>\,
rem                                    rebuilt whenever the launcher source moves, so a
rem                                    checkout always runs its own code, not the last release
rem   3. user-global cached binary  %USERPROFILE%\.cache\kungfu\shifu\<version>\
rem   4. fnm + uv already installed -> proven in-script bootstrap below
rem                                    (force native instead with SHIFU_NATIVE=1)
rem   5. fresh machine              -> download the prebuilt binary pinned by
rem                                    crates\shifu\Cargo.toml (SHIFU_DIST_MIRROR
rem                                    overrides the base URL), or cargo build from source
rem The native launcher bootstraps fnm + uv itself when missing (prebuilt binaries),
rem and loads the MSVC environment when cl.exe is absent. The in-script bootstrap
rem kept below still requires the two one-time prerequisites:
rem fnm (winget install Schniz.fnm) + uv (winget install astral-sh.uv).
rem
rem Repo has zero LAN/mirror coupling (open-source clone uses official upstreams). For LAN cache /
rem CN mirror, use `shifu config` to derive build-local.env.example into the user-global file:
rem   %USERPROFILE%\.config\kungfu\build-local.env  (sh-format, shared by main repo and all worktrees)
rem This .cmd parses that file with pure cmd to load mirror env; optional repo .\build-local.env overrides.
setlocal enabledelayedexpansion
cd /d "%~dp0"

rem Load local cache proxy config: user-global first, then optional in-repo override (set propagates to children).
set "_KFC_USERCFG=%USERPROFILE%\.config\kungfu\build-local.env"
if defined XDG_CONFIG_HOME set "_KFC_USERCFG=%XDG_CONFIG_HOME%\kungfu\build-local.env"
call :loadenv "%_KFC_USERCFG%"
call :loadenv ".\build-local.env"

rem Mark the canonical entrypoint and keep native dispatches from re-delegating here.
set "SHIFU_FROM_SHIM=1"
set "SHIFU_ENTRYPOINT=1"

rem -- Native launcher resolution ------------------------------------------------
if "%SHIFU_NATIVE%"=="0" goto inscript

if defined SHIFU_BIN if exist "%SHIFU_BIN%" (
  "%SHIFU_BIN%" %*
  exit /b !errorlevel!
)

set "_KFC_VER="
for /f "usebackq tokens=2 delims== " %%v in (`findstr /b /c:"version = " crates\shifu\Cargo.toml`) do (
  if not defined _KFC_VER set "_KFC_VER=%%~v"
)
set "_KFC_CACHE=%USERPROFILE%\.cache"
if defined XDG_CACHE_HOME set "_KFC_CACHE=%XDG_CACHE_HOME%"
set "_KFC_BIN=%_KFC_CACHE%\kungfu\shifu\%_KFC_VER%\shifu.exe"

rem Source freshness (dev machines): with cargo + git the cache slot is
rem content-addressed by the last commit touching the launcher source, so the
rem checkout's current code - not the last release, whose pin does not move
rem between releases - answers. Dirty launcher trees rebuild on every call
rem (cargo's own freshness check keeps repeats fast). Machines without cargo
rem keep the release-pinned path below unchanged.
where cargo >nul 2>nul || goto pinslot
where git >nul 2>nul || goto pinslot
if not defined _KFC_VER goto pinslot
set "_KFC_SRC="
rem rev-list instead of log --format: a percent format inside a for /f
rem backquote command gets percent-processed again by the child cmd, so git
rem receives a literal %h and fails; rev-list needs no format at all.
for /f "usebackq" %%s in (`git rev-list -1 --abbrev-commit HEAD -- crates/shifu crates/shifu-core crates/Cargo.toml crates/Cargo.lock 2^>nul`) do set "_KFC_SRC=%%s"
if not defined _KFC_SRC goto pinslot
set "_KFC_DIRTY="
for /f "usebackq delims=" %%s in (`git status --porcelain -- crates/shifu crates/shifu-core crates/Cargo.toml crates/Cargo.lock 2^>nul`) do set "_KFC_DIRTY=1"
if defined _KFC_DIRTY set "_KFC_SRC=%_KFC_SRC%-dirty"
set "_KFC_DEVDIR=%_KFC_CACHE%\kungfu\shifu\%_KFC_VER%-%_KFC_SRC%"
set "_KFC_DEVBIN=%_KFC_DEVDIR%\shifu.exe"
if not defined _KFC_DIRTY if exist "%_KFC_DEVBIN%" (
  "%_KFC_DEVBIN%" %*
  exit /b !errorlevel!
)
rem Build with an out-of-repo target dir (keyed per checkout) so read-only
rem checkouts build too.
set "_KFC_TGTKEY=%CD:\=_%"
set "_KFC_TGTKEY=%_KFC_TGTKEY::=%"
set "_KFC_TGT=%_KFC_CACHE%\kungfu\shifu\cargo-target\%_KFC_TGTKEY%"
echo shifu: building launcher from source ^(cargo build --release^) 1>&2
set "CARGO_TARGET_DIR=%_KFC_TGT%"
cargo build --release --locked --manifest-path crates\Cargo.toml -p shifu 1>&2 && (
  set "CARGO_TARGET_DIR="
  if not exist "%_KFC_DEVDIR%" mkdir "%_KFC_DEVDIR%" >nul 2>nul
  copy /y "%_KFC_TGT%\release\shifu.exe" "%_KFC_DEVBIN%" >nul && (
    rem Retire older source-keyed slots; the release-pinned slot stays.
    for /d %%d in ("%_KFC_CACHE%\kungfu\shifu\%_KFC_VER%-*") do (
      if /i not "%%~fd"=="%_KFC_DEVDIR%" rd /s /q "%%~fd" >nul 2>nul
    )
    "%_KFC_DEVBIN%" %*
    exit /b !errorlevel!
  )
)
set "CARGO_TARGET_DIR="
echo shifu: source build failed; falling back to the release-pinned launcher 1>&2

:pinslot
if exist "%_KFC_BIN%" (
  "%_KFC_BIN%" %*
  exit /b !errorlevel!
)

rem Machines with both prerequisites keep the proven in-script path below;
rem fresh machines (or SHIFU_NATIVE=1) acquire the native launcher.
if "%SHIFU_NATIVE%"=="1" goto acquire
where fnm >nul 2>nul || goto acquire
where uv >nul 2>nul || goto acquire
goto inscript

:acquire
set "_KFC_BASE=https://github.com/kungfu-systems/kungfu/releases/download"
if defined SHIFU_DIST_MIRROR set "_KFC_BASE=%SHIFU_DIST_MIRROR%"
set "_KFC_URL=%_KFC_BASE%/shifu-v%_KFC_VER%/shifu-windows-x64.exe"
where curl >nul 2>nul && (
  echo shifu: fetching prebuilt launcher %_KFC_VER% ^(windows-x64^) 1>&2
  if not exist "%_KFC_CACHE%\kungfu\shifu\%_KFC_VER%" mkdir "%_KFC_CACHE%\kungfu\shifu\%_KFC_VER%" >nul 2>nul
  curl -fsSL --retry 2 --connect-timeout 20 -o "%_KFC_BIN%.tmp" "%_KFC_URL%" && (
    move /y "%_KFC_BIN%.tmp" "%_KFC_BIN%" >nul
    "%_KFC_BIN%" %*
    exit /b !errorlevel!
  )
  del "%_KFC_BIN%.tmp" >nul 2>nul
)
where cargo >nul 2>nul && (
  echo shifu: building native launcher from source ^(cargo build --release^) 1>&2
  cargo build --release --manifest-path crates\Cargo.toml -p shifu 1>&2 && (
    if not exist "%_KFC_CACHE%\kungfu\shifu\%_KFC_VER%" mkdir "%_KFC_CACHE%\kungfu\shifu\%_KFC_VER%" >nul 2>nul
    copy /y crates\target\release\shifu.exe "%_KFC_BIN%" >nul && (
      "%_KFC_BIN%" %*
      exit /b !errorlevel!
    )
  )
)
echo shifu: native launcher unavailable; falling back to the in-script bootstrap 1>&2

:inscript
rem In-script fallback versions of the launcher-owned flags (the native
rem launcher normally answers these before we get here).
if "%~1"=="" (
  echo shifu - the kungfu development/build launcher ^(pinned-toolchain entrypoint^)
  echo.
  echo   shifu ^<task^> [args...]     run any pnpm task under the pinned toolchain
  echo   shifu build ^| rebuild      bootstrap build ^(rebuild clears generated outputs^)
  echo   shifu cache ...            inspect the versioned cache contract and schemas
  echo   shifu proxy ^| config ...   manage local mirror/cache config
  echo   shifu --version            launcher version; shifu help for pnpm's own help
  echo.
  echo Common tasks: sync, build, check, fix, verify, dist, app  ^(docs: AGENTS.md^)
  exit /b 2
)
if "%~1"=="--version" goto scriptversion
if "%~1"=="-v" goto scriptversion
if "%~1"=="-V" goto scriptversion
goto richcheck

:scriptversion
echo shifu %_KFC_VER% ^(script^)
exit /b 0

:richcheck
rem -- Delegate rich subcommands to L2 node (no pnpm, no uv). Prefer fnm node, else system node. --
if /i "%~1"=="proxy"  goto delegate
if /i "%~1"=="config" goto delegate
if /i "%~1"=="cache"  goto delegate
goto bootstrap

:delegate
where fnm >nul 2>nul && (
  fnm install >nul 2>nul
  fnm exec --using-file -- node "%~dp0shifu.mjs" %*
  exit /b !errorlevel!
)
where node >nul 2>nul && (
  node "%~dp0shifu.mjs" %*
  exit /b !errorlevel!
)
echo shifu: rich subcommand needs node -- install fnm ^(winget install Schniz.fnm^) or any system node 1>&2
exit /b 127

:bootstrap
where fnm >nul 2>nul || (
  echo shifu: install fnm first ^(node-side prereq^) -- winget install Schniz.fnm ^(or https://github.com/Schniz/fnm^) 1>&2
  exit /b 127
)
where uv >nul 2>nul || (
  echo shifu: install uv first ^(python-side prereq^) -- winget install astral-sh.uv ^(or https://docs.astral.sh/uv/^) 1>&2
  exit /b 127
)

rem Idempotent: ensure the node pinned by .node-version is installed
fnm install >nul 2>nul

rem Under the pinned node, run the packageManager-pinned pnpm via corepack.
rem NOTE: use corepack.cmd (not bare "corepack"): fnm exec spawns the program directly
rem without applying PATHEXT, so bare "corepack" is not found on Windows (only corepack.cmd is).
fnm exec --using-file -- corepack.cmd pnpm %*
exit /b !errorlevel!

rem -- Parse sh-format build-local.env `export KEY='VALUE'` lines -> set KEY=VALUE (pure cmd) --
rem (Windows cmd cannot source sh; take export lines, strip the export prefix and single quotes;
rem  mirror URLs have no embedded quotes/equals so this is safe.)
:loadenv
if not exist "%~1" goto :eof
for /f "usebackq tokens=1,* delims==" %%a in (`findstr /b /c:"export " "%~1"`) do (
  set "_kfc_k=%%a"
  set "_kfc_v=%%b"
  set "_kfc_k=!_kfc_k:export =!"
  set "_kfc_v=!_kfc_v:'=!"
  set "!_kfc_k!=!_kfc_v!"
)
set "_kfc_k="
set "_kfc_v="
goto :eof
