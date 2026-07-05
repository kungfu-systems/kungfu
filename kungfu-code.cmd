@echo off
rem kungfu-code.cmd - kungfu dev/build launcher (Windows), L1 of the 3-layer subset.
rem ASCII-only on purpose: Windows cmd parses .cmd in the OEM codepage (e.g. GBK/936),
rem so non-ASCII bytes corrupt parsing. Keep this file ASCII; the sh version may use UTF-8.
rem
rem Aligns with the macOS/Linux kungfu-code (sh):
rem   kungfu-code app | kungfu-code build:core | kungfu-code <any pnpm task>
rem   kungfu-code proxy ... / config ...   rich subcommands -> delegated to L2 node (not pnpm)
rem
rem 3-layer subset: L1 this .cmd (bootstrap + delegate); L2 kungfu-code.mjs (node rich cmds); L3 (future) TUI.
rem Two one-time prerequisites: fnm (winget install Schniz.fnm) + uv (winget install astral-sh.uv).
rem Repo has zero LAN/mirror coupling (open-source clone uses official upstreams). For LAN cache /
rem CN mirror, use `kungfu-code config` to derive build-local.env.example into the user-global file:
rem   %USERPROFILE%\.config\kungfu\build-local.env  (sh-format, shared by main repo and all worktrees)
rem This .cmd parses that file with pure cmd to load mirror env; optional repo .\build-local.env overrides.
setlocal enabledelayedexpansion
cd /d "%~dp0"

rem -- Delegate rich subcommands to L2 node (no pnpm, no uv). Prefer fnm node, else system node. --
if /i "%~1"=="proxy"  goto delegate
if /i "%~1"=="config" goto delegate
goto bootstrap

:delegate
where fnm >nul 2>nul && (
  fnm install >nul 2>nul
  fnm exec --using-file -- node "%~dp0kungfu-code.mjs" %*
  exit /b !errorlevel!
)
where node >nul 2>nul && (
  node "%~dp0kungfu-code.mjs" %*
  exit /b !errorlevel!
)
echo kungfu-code: rich subcommand needs node -- install fnm ^(winget install Schniz.fnm^) or any system node 1>&2
exit /b 127

:bootstrap
rem Load local cache proxy config: user-global first, then optional in-repo override (set propagates to children).
set "_KFC_USERCFG=%USERPROFILE%\.config\kungfu\build-local.env"
if defined XDG_CONFIG_HOME set "_KFC_USERCFG=%XDG_CONFIG_HOME%\kungfu\build-local.env"
call :loadenv "%_KFC_USERCFG%"
call :loadenv ".\build-local.env"

where fnm >nul 2>nul || (
  echo kungfu-code: install fnm first ^(node-side prereq^) -- winget install Schniz.fnm ^(or https://github.com/Schniz/fnm^) 1>&2
  exit /b 127
)
where uv >nul 2>nul || (
  echo kungfu-code: install uv first ^(python-side prereq^) -- winget install astral-sh.uv ^(or https://docs.astral.sh/uv/^) 1>&2
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
