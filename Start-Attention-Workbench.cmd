@echo off
setlocal
for %%I in ("%~dp0..\harness-mix") do set "HARNESSMIX_EXISTING=%%~fI"
set "HARNESSMIX_CLAUDE_HISTORY_DISCOVERY=1"
set "HARNESSMIX_CLAUDE_COMMAND=%HARNESSMIX_EXISTING%\claude-runtime\node_modules\@anthropic-ai\claude-code\bin\claude.exe"
set "PATH=%HARNESSMIX_EXISTING%\bin;%PATH%"
set "HARNESS_MIX_DSH_ROOT=%HARNESSMIX_EXISTING%\dsh-runtime"
set "HARNESS_MIX_AUTO_UPDATE=0"
set "HARNESSMIX_DATA_DIR=%LOCALAPPDATA%\Harness Mix\trial-data"
cd /d "%~dp0"
echo Harness Mix attention workbench - staged, auto-update disabled.
echo WARNING: this restarts Codex Desktop. Save other active work first.
echo Rollback launcher: "%HARNESSMIX_EXISTING%\Start-Harness-Mix-Previous.cmd"
"C:\Program Files\nodejs\node.exe" "%~dp0scripts\launch-codex.cjs" --no-update --restart
if errorlevel 1 pause
