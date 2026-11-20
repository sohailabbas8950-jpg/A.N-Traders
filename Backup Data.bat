@echo off
cd /d "%~dp0"
if not exist "data\inventory.db" (
  echo No database found in the data folder yet.
  pause
  exit /b 1
)
if not exist "backups" mkdir backups
set STAMP=%date:~-4%-%date:~4,2%-%date:~7,2%_%time:~0,2%%time:~3,2%
set STAMP=%STAMP: =0%
copy /y "data\inventory.db" "backups\inventory_%STAMP%.db" >nul
echo Backup saved in the backups folder: inventory_%STAMP%.db
echo Copy that folder to a USB drive now and then.
pause
