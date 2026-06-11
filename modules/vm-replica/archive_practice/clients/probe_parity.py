# -*- coding: utf-8 -*-
"""Probe zhou's environment (via inner agent) to diff against Devin's own VM."""
import json, urllib.request, sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
CFG = json.load(open(r'C:\ProgramData\dao_vm\config.json', encoding='utf-8'))
HOST = "http://127.0.0.1:%d/" % CFG['host_port']; TOKEN = CFG['token']
def call(a, **k):
    req = urllib.request.Request(HOST, data=json.dumps(dict(action=a, **k)).encode(),
        method='POST', headers={'Content-Type':'application/json','Authorization':'Bearer '+TOKEN})
    return json.loads(urllib.request.urlopen(req, timeout=120).read().decode())
def zexec(cmd):
    return call('vm.exec', vm='zhou', command=cmd).get('stdout','').strip()

ps = (
 "$o=@(); "
 "function chk($n,$c){ try{ $v=(& cmd /c $c) 2>$null; $o+= ('{0}: {1}' -f $n, ($v -join ' ')) }catch{ $o+= ('{0}: MISSING' -f $n) } } ; "
 "$o += 'OS: ' + (Get-CimInstance Win32_OperatingSystem).Caption; "
 "Add-Type -AssemblyName System.Windows.Forms; $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; "
 "$o += 'screen: ' + $b.Width + 'x' + $b.Height; "
 "$o += 'AppliedDPI: ' + (Get-ItemProperty 'HKCU:\\Control Panel\\Desktop\\WindowMetrics' -EA SilentlyContinue).AppliedDPI; "
 "foreach($t in @('node --version','npm --version','python --version','git --version','code --version')){ "
 "  $exe=$t.Split(' ')[0]; $g=Get-Command $exe -EA SilentlyContinue; "
 "  if($g){ $o += ($exe + ': ' + ((& cmd /c $t 2>$null) -join ' ')) } else { $o += ($exe + ': MISSING') } } ; "
 "$o += 'winget: ' + $(if(Get-Command winget -EA SilentlyContinue){'present'}else{'MISSING'}); "
 "$o += 'chrome: ' + $(if(Test-Path 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'){'present'}elseif(Test-Path 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'){'present-x86'}else{'MISSING'}); "
 "$o += 'vscode-dir: ' + $(if(Test-Path 'C:\\Program Files\\Microsoft VS Code\\Code.exe'){'machine'}elseif(Test-Path ($env:LOCALAPPDATA+'\\Programs\\Microsoft VS Code\\Code.exe')){'user'}else{'MISSING'}); "
 "$o -join \"`n\""
)
import base64
enc = base64.b64encode(ps.encode('utf-16-le')).decode()
print("=== ZHOU environment ===")
print(zexec('powershell -NoProfile -EncodedCommand ' + enc))
