import sys, os, json, base64
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from dao_sdk import api

AGENT = "141"

# PowerShell script: resolve project dir via wildcard (avoid Chinese in cmd),
# walk all files, emit base64(UTF8(JSON)) so encoding survives the relay.
PS = r'''
$ProgressPreference='SilentlyContinue'
$ErrorActionPreference='Stop'
$root = Get-ChildItem 'E:\DAO_ARCHIVE' -Directory | Where-Object { $_.Name -like '20_*' } | Select-Object -First 1
$p = $root.FullName
$items = @(Get-ChildItem -LiteralPath $p -Recurse -Force)
$textExt = @('.md','.py','.txt','.json','.ps1','.bat','.cmd','.cs','.toml','.yml','.yaml','.cfg','.ini','.xml','.html','.js','.ts','.csproj','.sln','.gitignore','')
$out = @()
foreach($f in $items){
  $rel = $f.FullName.Substring($p.Length)
  $isDir = [bool]$f.PSIsContainer
  $len = 0
  $content = ''
  if(-not $isDir){
    $len = $f.Length
    $ext = $f.Extension.ToLower()
    if(($textExt -contains $ext) -and $len -lt 300000){
      try { $content = [IO.File]::ReadAllText($f.FullName) } catch { $content = '[[READ_ERR]]' }
    }
  }
  $out += [PSCustomObject]@{ rel=$rel; dir=$isDir; len=$len; content=$content }
}
$meta = [PSCustomObject]@{ root=$p; count=$items.Count; files=$out }
$json = $meta | ConvertTo-Json -Depth 6 -Compress
$bytes = [Text.Encoding]::UTF8.GetBytes($json)
[Convert]::ToBase64String($bytes)
'''

# Encode PS as base64 and run via powershell -EncodedCommand (UTF-16LE) to dodge all codepage issues.
enc = base64.b64encode(PS.encode('utf-16-le')).decode()
cmd = f'powershell -NoProfile -NonInteractive -EncodedCommand {enc}'

r = api("POST", "/api/exec-sync", {"agent_id": AGENT, "cmd": cmd, "timeout": 90}, timeout=120)
if r.get("status") != "completed":
    print("EXEC FAILED:", json.dumps(r, ensure_ascii=False)[:2000]); sys.exit(1)

b64 = r["result"]["stdout"].strip()
err = r["result"].get("stderr","")
if err.strip():
    print("STDERR:", err[:1000])
try:
    data = json.loads(base64.b64decode(b64).decode('utf-8'))
except Exception as e:
    print("DECODE FAIL:", e)
    print("RAW STDOUT (first 1500):", b64[:1500])
    sys.exit(1)

# Save full snapshot locally
with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'project_snapshot.json'), 'w', encoding='utf-8') as fh:
    json.dump(data, fh, ensure_ascii=False, indent=2)

print("ROOT:", data["root"])
print("COUNT:", data["count"])
print("=== FILE TREE ===")
for f in sorted(data["files"], key=lambda x: x["rel"]):
    tag = "DIR " if f["dir"] else f'{f["len"]:>7}'
    print(f'{tag}  {f["rel"]}')
