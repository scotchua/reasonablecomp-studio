@echo off
setlocal
set "APP=%~dp0index.html"
set "EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if exist "%EDGE%" (
  start "ReasonableComp Studio" "%EDGE%" --app="file:///%APP:\=/%" --start-maximized
) else (
  start "ReasonableComp Studio" "%APP%"
)
endlocal
