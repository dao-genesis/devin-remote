import subprocess, time, sys, io
# runs interactively in session 1 (via scheduled task) -> same window station as mstsc dialogs
LOG = r"C:\ProgramData\dao-vm\connector.log"
def log(*a):
    s=" ".join(str(x) for x in a)
    with open(LOG,"a",encoding="utf-8") as f: f.write(s+"\n")
    print(s, flush=True)

try:
    import win32gui, win32con, win32api, win32process
except Exception as e:
    log("no win32:", e); win32gui=None

AFFIRM = ["连接","是(","确定","连接(","Connect","Yes","OK","是"]

def click_dialogs():
    if not win32gui: return
    hits=[]
    def cb(hwnd, _):
        try:
            if not win32gui.IsWindowVisible(hwnd): return
            if win32gui.GetClassName(hwnd) != "#32770": return
        except Exception: return
        title=win32gui.GetWindowText(hwnd)
        def child(ch, __):
            try:
                if win32gui.GetClassName(ch).lower()!="button": return
                txt=win32gui.GetWindowText(ch)
            except Exception: return
            if any(a in txt for a in AFFIRM):
                try:
                    win32gui.SendMessage(ch, win32con.BM_CLICK, 0, 0)
                    hits.append((title,txt))
                except Exception: pass
        try: win32gui.EnumChildWindows(hwnd, child, None)
        except Exception: pass
    try: win32gui.EnumWindows(cb, None)
    except Exception as e: log("enum err", e)
    return hits

def daovm_active():
    try:
        out=subprocess.run(["qwinsta"],capture_output=True,text=True,timeout=10).stdout or ""
    except Exception:
        return None,False
    row=None; act=False
    for l in out.splitlines():
        if "daovm" in l.lower():
            row=l.strip(); act = "active" in l.lower()
    return row, act

# kill stray loopback mstsc (keep user 179=8728)
subprocess.run(["powershell","-NoProfile","-Command","Get-Process mstsc -EA SilentlyContinue | ?{$_.Id -ne 8728} | Stop-Process -Force -EA SilentlyContinue"], capture_output=True)
time.sleep(2)
DETACHED = 0x00000008 | 0x00000200
mp = subprocess.Popen(["mstsc.exe", r"C:\ProgramData\dao-vm\daovm.rdp"], creationflags=DETACHED)
log("launched mstsc pid", mp.pid)

triggered=False
for i in range(45):  # ~150s
    hits = click_dialogs()
    row, act = daovm_active()
    log("iter %d clicked=%r daovm=%r active=%s" % (i+1, hits, row, act))
    if row and not triggered:
        subprocess.run(["powershell","-NoProfile","-Command","Start-ScheduledTask DaoVMAgent"], capture_output=True)
        triggered=True; log("  triggered DaoVMAgent")
    try:
        import urllib.request
        r=urllib.request.urlopen("http://127.0.0.1:9931/health",timeout=3).read().decode()
        if '"ok": true' in r.lower(): log("HEALTHY", r); break
    except Exception: pass
    time.sleep(3)
log("connector done")
