@echo off
REM ============================================================================
REM  DAO vm-replica  ·  141 boot-safe recovery  (run as Administrator)
REM  Use if the desktop fails to reach the logon/desktop, RDP keeps crashing,
REM  or the machine auto-reboots ("RPC server unavailable" / can't sign in).
REM  Restores native RDP, single-session, NEVER-reboot recovery, disables the
REM  DAO RDP-injection auto-start tasks. Leaves RDP Wrapper files for manual use.
REM ============================================================================
echo [*] Restoring native TermService ServiceDll (stops rdpwrap crash loop)...
reg add "HKLM\SYSTEM\CurrentControlSet\Services\TermService\Parameters" /v ServiceDll /t REG_EXPAND_SZ /d "%%SystemRoot%%\System32\termsrv.dll" /f

echo [*] Native single-session default...
reg add "HKLM\SYSTEM\CurrentControlSet\Control\Terminal Server" /v fSingleSessionPerUser /t REG_DWORD /d 1 /f
reg add "HKLM\SYSTEM\CurrentControlSet\Control\Terminal Server" /v fDenyTSConnections /t REG_DWORD /d 0 /f

echo [*] Service recovery = restart service only, NEVER reboot the computer...
sc failure TermService reset= 86400 actions= restart/60000/restart/60000/restart/60000

echo [*] Disabling DAO RDP-injection auto-start tasks...
for %%T in (DaoVMAgent DaoVMConnect DaoVMConnector DaoVMConn2 dao_host_daemon dao_agent_zhou DaoVMScan) do schtasks /Change /TN "%%T" /DISABLE 2>nul

echo [*] Restarting TermService with native termsrv...
net stop UmRdpService /y 2>nul
sc stop TermService 2>nul
timeout /t 3 /nobreak >nul
sc start TermService
echo.
echo [OK] Boot-safe RDP restored: native termsrv, single-session, no auto-reboot.
echo     Multi-RDP (RDP Wrapper) left installed but inactive; enable manually if needed.
pause
