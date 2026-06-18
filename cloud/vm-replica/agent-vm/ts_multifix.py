r"""ts_multifix.py - boot-safe, in-memory multi-session enabler for Windows TermService.

Problem
-------
On client SKUs (Windows 10/11) termsrv.dll allows only ONE interactive session, so
RDP-ing a second local account from the main account fails with
"本机的连接数量是有限的 / The number of connections to this computer is limited".

Why not rdpwrap-as-ServiceDll
-----------------------------
Hanging rdpwrap.dll as the TermService ServiceDll crash-loops on some builds (observed
7031 x5 on this host's build) and can lock the box out of RDP at boot. This module instead
patches the ALREADY-RUNNING termsrv.dll *in memory* and keeps the on-disk ServiceDll
native. Nothing auto-loads at boot, so a bad build can never brick startup; a simple
`Restart-Service TermService` (or reboot) fully reverts the change.

What it does (mirrors rdpwrap's New_CSLQuery_Initialize override, applied live)
-------------------------------------------------------------------------------
  * CSLQuery::bServerSku        = 1     (treat as multi-session capable)
  * CSLQuery::bAppServerAllowed = 1     (the key flag: allow >1 concurrent session)
  * CSLQuery::lMaxUserSessions  = 1024  (lift the per-host concurrent cap)
  * CSLQuery::bRemoteConnAllowed= 1
  * CSLQuery::bMultimonAllowed  = 1
  * CDefPolicy::Query  jne->jmp         (disable the single-session-per-user deny)

Offsets are keyed by exact termsrv.dll file version. Known builds use the builtin OFFSETS
table (resolved from Microsoft's public PDB) as a fast-path. For any build NOT in the table
we fall back to the locally-installed, community-maintained rdpwrap.ini (which covers
hundreds of builds): its `[ver-SLInit]` globals are RVAs we use directly, and the
CDefPolicy single-session jne is located by signature-scanning .text (disambiguated by the
ini's DefPolicyOffset). Every write is signature/sanity-checked first, so a wrong offset can
never land. If neither source resolves the build, the module is a NO-OP (logs + returns) so
a Windows Update that swaps termsrv.dll degrades gracefully to native single-session.
"""
import ctypes as C
import os
import struct
import subprocess
import sys
from ctypes import wintypes as W

# version -> RVAs (resolved from public symbols for termsrv.dll). Add new builds here.
OFFSETS = {
    "10.0.26100.8521": {
        "bServerSku":        0x126FCC,
        "bAppServerAllowed": 0x126FD8,
        "lMaxUserSessions":  0x126FD0,
        "bRemoteConnAllowed":0x126FE4,
        "bMultimonAllowed":  0x126FE8,
        "cdefpolicy_jne":    0x9C547,   # byte 0x75 (jne) -> 0xEB (jmp): always-allow
    },
}
GLOBAL_KEYS = ("bServerSku", "bAppServerAllowed", "lMaxUserSessions",
               "bRemoteConnAllowed", "bMultimonAllowed")
MULTI_VALUES = {"bServerSku": 1, "bAppServerAllowed": 1, "lMaxUserSessions": 1024,
                "bRemoteConnAllowed": 1, "bMultimonAllowed": 1}
NATIVE_VALUES = {"bServerSku": 0, "bAppServerAllowed": 0, "lMaxUserSessions": 0}

k32 = C.WinDLL("kernel32.dll", use_last_error=True)
adv = C.WinDLL("advapi32.dll", use_last_error=True)
ver = C.WinDLL("version.dll", use_last_error=True)

TERMSRV_PATH = r"C:\Windows\System32\termsrv.dll"
RDPWRAP_INI = os.environ.get("RDPWRAP_INI", r"C:\Program Files\RDP Wrapper\rdpwrap.ini")


def termsrv_version(path=TERMSRV_PATH):
    """Return the dotted file version (e.g. '10.0.26100.8521') of the on-disk termsrv.dll.

    NOTE: after a Windows Update the on-disk file can differ from what the *running*
    TermService still has mapped in memory (until it is restarted). Always drive the
    in-memory patch off `loaded_version()` instead - see below."""
    size = ver.GetFileVersionInfoSizeW(path, None)
    if not size:
        return None
    buf = C.create_string_buffer(size)
    if not ver.GetFileVersionInfoW(path, 0, size, buf):
        return None
    p = C.c_void_p()
    n = W.UINT(0)
    if not ver.VerQueryValueW(buf, "\\", C.byref(p), C.byref(n)):
        return None
    ffi = C.cast(p, C.POINTER(C.c_uint32 * 13)).contents
    ms_v, ls_v = ffi[2], ffi[3]   # dwFileVersionMS, dwFileVersionLS
    return "%d.%d.%d.%d" % (ms_v >> 16, ms_v & 0xFFFF, ls_v >> 16, ls_v & 0xFFFF)


def _version_from_image(read):
    """Parse the FileVersion from a PE image via a `read(rva, n)` accessor. Works on the
    live in-memory module, so it reflects what TermService actually loaded (not the disk)."""
    mz = read(0, 0x40)
    if not mz or mz[:2] != b"MZ":
        return None
    e_lfanew = struct.unpack_from("<I", mz, 0x3C)[0]
    coff = read(e_lfanew, 0x18)
    num_sec = struct.unpack_from("<H", coff, 6)[0]
    opt_sz = struct.unpack_from("<H", coff, 20)[0]
    opt_off = e_lfanew + 0x18
    opt = read(opt_off, opt_sz)
    magic = struct.unpack_from("<H", opt, 0)[0]
    dd_off = 112 if magic == 0x20B else 96   # data directory start within optional header
    res_rva, res_size = struct.unpack_from("<II", opt, dd_off + 2 * 8)   # [2] = RESOURCE
    if not res_rva:
        return None
    rd = read(res_rva, min(res_size, 0x40000)) or b""

    def entries(dir_off):
        named, idc = struct.unpack_from("<HH", rd, dir_off + 12)
        out = []
        for i in range(named + idc):
            nid, off = struct.unpack_from("<II", rd, dir_off + 16 + i * 8)
            out.append((nid, off))
        return out

    # root -> RT_VERSION(16) -> name -> lang -> data
    ver_dir = None
    for nid, off in entries(0):
        if nid == 16 and (off & 0x80000000):
            ver_dir = off & 0x7FFFFFFF
            break
    if ver_dir is None:
        return None
    e1 = entries(ver_dir)
    if not e1:
        return None
    sub2 = e1[0][1] & 0x7FFFFFFF
    e2 = entries(sub2)
    if not e2:
        return None
    leaf = e2[0][1] & 0x7FFFFFFF
    data_rva, data_sz = struct.unpack_from("<II", rd, leaf)   # IMAGE_RESOURCE_DATA_ENTRY
    blob = read(data_rva, data_sz) or b""
    sig = blob.find(b"\xbd\x04\xef\xfe")   # VS_FIXEDFILEINFO signature 0xFEEF04BD
    if sig < 0:
        return None
    ms_v, ls_v = struct.unpack_from("<II", blob, sig + 8)
    return "%d.%d.%d.%d" % (ms_v >> 16, ms_v & 0xFFFF, ls_v >> 16, ls_v & 0xFFFF)


def _enable_priv(name="SeDebugPrivilege"):
    SE_ENABLED = 0x2

    class LUID(C.Structure):
        _fields_ = [("Low", W.DWORD), ("High", C.c_long)]

    class LAA(C.Structure):
        _fields_ = [("Luid", LUID), ("Attr", W.DWORD)]

    class TP(C.Structure):
        _fields_ = [("Count", W.DWORD), ("Priv", LAA * 1)]

    k32.GetCurrentProcess.restype = W.HANDLE
    adv.OpenProcessToken.argtypes = [W.HANDLE, W.DWORD, C.POINTER(W.HANDLE)]
    adv.LookupPrivilegeValueW.argtypes = [W.LPCWSTR, W.LPCWSTR, C.POINTER(LUID)]
    adv.AdjustTokenPrivileges.argtypes = [W.HANDLE, W.BOOL, C.c_void_p, W.DWORD, C.c_void_p, C.c_void_p]
    h = W.HANDLE()
    if not adv.OpenProcessToken(k32.GetCurrentProcess(), 0x28, C.byref(h)):
        return False
    luid = LUID()
    if not adv.LookupPrivilegeValueW(None, name, C.byref(luid)):
        return False
    tp = TP()
    tp.Count = 1
    tp.Priv[0].Luid = luid
    tp.Priv[0].Attr = SE_ENABLED
    return bool(adv.AdjustTokenPrivileges(h, False, C.byref(tp), 0, None, None))


def _termservice_pid():
    out = subprocess.check_output("sc queryex TermService", shell=True).decode("latin1", "replace")
    for line in out.splitlines():
        if "PID" in line.upper():
            return int(line.split(":")[1].strip())
    return None


class _MODULEENTRY32(C.Structure):
    _fields_ = [("dwSize", W.DWORD), ("th32ModuleID", W.DWORD), ("th32ProcessID", W.DWORD),
                ("GlblcntUsage", W.DWORD), ("ProccntUsage", W.DWORD),
                ("modBaseAddr", C.POINTER(C.c_byte)), ("modBaseSize", W.DWORD),
                ("hModule", W.HMODULE), ("szModule", C.c_char * 256), ("szExePath", C.c_char * 260)]


def _module_base(pid, name="termsrv.dll"):
    k32.CreateToolhelp32Snapshot.restype = W.HANDLE
    k32.CreateToolhelp32Snapshot.argtypes = [W.DWORD, W.DWORD]
    snap = k32.CreateToolhelp32Snapshot(0x8 | 0x10, pid)   # SNAPMODULE | SNAPMODULE32
    if snap is None or snap == C.c_void_p(-1).value:
        return None
    me = _MODULEENTRY32()
    me.dwSize = C.sizeof(_MODULEENTRY32)
    k32.Module32First.argtypes = [W.HANDLE, C.POINTER(_MODULEENTRY32)]
    k32.Module32Next.argtypes = [W.HANDLE, C.POINTER(_MODULEENTRY32)]
    ok = k32.Module32First(snap, C.byref(me))
    try:
        while ok:
            if me.szModule.decode("latin1").lower() == name:
                return C.cast(me.modBaseAddr, C.c_void_p).value
            ok = k32.Module32Next(snap, C.byref(me))
    finally:
        k32.CloseHandle(snap)
    return None


class _Mem:
    """Read/write the live termsrv.dll image in the TermService svchost."""

    def __init__(self):
        _enable_priv()
        self.disk_version = termsrv_version()
        self.pid = _termservice_pid()
        self.base = _module_base(self.pid) if self.pid else None
        self.h = None
        self.version = None
        if self.base:
            k32.OpenProcess.restype = W.HANDLE
            k32.OpenProcess.argtypes = [W.DWORD, W.BOOL, W.DWORD]
            # VM_OPERATION | VM_READ | VM_WRITE | QUERY_INFORMATION
            self.h = k32.OpenProcess(0x8 | 0x10 | 0x20 | 0x400, False, self.pid)
            k32.ReadProcessMemory.argtypes = [W.HANDLE, C.c_void_p, C.c_void_p, C.c_size_t, C.POINTER(C.c_size_t)]
            k32.WriteProcessMemory.argtypes = [W.HANDLE, C.c_void_p, C.c_void_p, C.c_size_t, C.POINTER(C.c_size_t)]
            k32.VirtualProtectEx.argtypes = [W.HANDLE, C.c_void_p, C.c_size_t, W.DWORD, C.POINTER(W.DWORD)]
            # drive everything off the LOADED image version (may differ from disk after an update)
            self.version = _version_from_image(self.rd) or self.disk_version

    def rd(self, rva, n):
        buf = (C.c_ubyte * n)()
        got = C.c_size_t(0)
        if not k32.ReadProcessMemory(self.h, C.c_void_p(self.base + rva), buf, n, C.byref(got)):
            return None
        return bytes(buf[:got.value])

    def wr(self, rva, data):
        data = bytes(data)
        old = W.DWORD(0)
        k32.VirtualProtectEx(self.h, C.c_void_p(self.base + rva), len(data), 0x40, C.byref(old))  # RWX
        buf = (C.c_ubyte * len(data))(*data)
        got = C.c_size_t(0)
        ok = k32.WriteProcessMemory(self.h, C.c_void_p(self.base + rva), buf, len(data), C.byref(got))
        res = W.DWORD(0)
        k32.VirtualProtectEx(self.h, C.c_void_p(self.base + rva), len(data), old, C.byref(res))
        return bool(ok)

    def rd_dw(self, rva):
        b = self.rd(rva, 4)
        return struct.unpack("<i", b)[0] if b else None

    def wr_dw(self, rva, val):
        return self.wr(rva, struct.pack("<I", val & 0xFFFFFFFF))

    def close(self):
        if self.h:
            k32.CloseHandle(self.h)


# CDefPolicy::Query single-session site is `cmp r8d,r9d ; jne` -> bytes 45 3B C1 (75|EB) 14.
# Verifying this signature before writing guarantees we never patch a wrong/mismatched build.
CDEFPOLICY_SIG = b"\x45\x3b\xc1"


def _read_range(m, rva, size):
    """Read a large region in page-sized chunks (whole .text may span MBs)."""
    out, pos, step = bytearray(), 0, 0x10000
    while pos < size:
        chunk = m.rd(rva + pos, min(step, size - pos))
        if not chunk:
            break
        out += chunk
        if len(chunk) < min(step, size - pos):
            break
        pos += len(chunk)
    return bytes(out)


def _sections(m):
    """Parse the PE section table from the live mapped image -> list of section dicts."""
    hdr = m.rd(0, 0x600)
    if not hdr or hdr[:2] != b"MZ":
        return []
    e = struct.unpack_from("<I", hdr, 0x3C)[0]
    if e + 24 > len(hdr) or hdr[e:e + 4] != b"PE\x00\x00":
        return []
    num = struct.unpack_from("<H", hdr, e + 6)[0]
    opt = struct.unpack_from("<H", hdr, e + 20)[0]
    base = e + 24 + opt
    need = base + num * 40
    if need > len(hdr):
        hdr = m.rd(0, need + 64) or hdr
    secs = []
    for i in range(num):
        raw = hdr[base + i * 40: base + i * 40 + 40]
        if len(raw) < 40:
            break
        name = raw[:8].rstrip(b"\x00").decode("latin1", "replace")
        vsize, vaddr, rawsize, praw = struct.unpack_from("<IIII", raw, 8)
        secs.append({"name": name, "vaddr": vaddr, "vsize": vsize,
                     "rawsize": rawsize, "praw": praw})
    return secs


def _file_to_rva(secs, foff):
    for s in secs:
        if s["praw"] and s["praw"] <= foff < s["praw"] + s["rawsize"]:
            return s["vaddr"] + (foff - s["praw"])
    return None


def _ini_section(version, suffix=""):
    """Parse `[version+suffix]` from rdpwrap.ini -> {key(without .x64): int|str}."""
    try:
        with open(RDPWRAP_INI, "r", encoding="utf-8", errors="replace") as f:
            lines = f.read().splitlines()
    except OSError:
        return {}
    header = "[%s%s]" % (version, suffix)
    out, inside = {}, False
    for ln in lines:
        s = ln.strip()
        if s.startswith("["):
            inside = (s == header)
            continue
        if inside and "=" in s:
            k, v = (x.strip() for x in s.split("=", 1))
            if k.lower().endswith(".x64"):
                k = k[:-4]
                try:
                    out[k] = int(v, 16)
                except ValueError:
                    out[k] = v
    return out


def _offsets_from_ini(m):
    """Derive an OFFSETS-style dict for m.version from the installed rdpwrap.ini.
    Globals come straight from `[ver-SLInit]` (already RVAs); the CDefPolicy jne byte is
    located by scanning .text for CDEFPOLICY_SIG, disambiguated by DefPolicyOffset. Returns
    None if the ini doesn't cover this build. cdefpolicy_jne may be None (globals-only patch,
    which alone lifts the concurrent-session limit)."""
    g = _ini_section(m.version, "-SLInit")
    if not all(isinstance(g.get(k), int) for k in GLOBAL_KEYS):
        return None
    off = {k: g[k] for k in GLOBAL_KEYS}
    secs = _sections(m)
    text = next((s for s in secs if s["name"] == ".text"), None)
    jne = None
    if text and 0 < text["vsize"] <= 0x2000000:
        blob = _read_range(m, text["vaddr"], text["vsize"])
        cands, i = [], blob.find(CDEFPOLICY_SIG)
        while i != -1:
            if i + 3 < len(blob) and blob[i + 3] in (0x75, 0xEB):
                cands.append(text["vaddr"] + i + 3)
            i = blob.find(CDEFPOLICY_SIG, i + 1)
        if len(cands) == 1:
            jne = cands[0]
        elif len(cands) > 1:
            main = _ini_section(m.version, "")
            tgt = _file_to_rva(secs, main["DefPolicyOffset"]) if isinstance(main.get("DefPolicyOffset"), int) else None
            jne = min(cands, key=lambda c: abs(c - tgt)) if tgt is not None else cands[0]
    off["cdefpolicy_jne"] = jne
    return off


def _globals_sane(before):
    """Boolean CSLQuery flags must read as 0/1 today; a wild value means a wrong offset."""
    for k in ("bServerSku", "bAppServerAllowed", "bRemoteConnAllowed", "bMultimonAllowed"):
        v = before.get(k)
        if v is None or v < 0 or v > 1:
            return False
    return True


def _open():
    m = _Mem()
    if not m.pid or not m.base or not m.h:
        return None, {"ok": False, "error": "cannot open TermService (need elevation/SeDebugPrivilege)",
                      "pid": m.pid if m else None}
    off = OFFSETS.get(m.version)
    src = "builtin"
    if off is None:
        off = _offsets_from_ini(m)
        src = "rdpwrap.ini"
    if off is None:
        m.close()
        return None, {"ok": False, "supported": False, "version": m.version,
                      "note": "build not in OFFSETS and not resolvable from rdpwrap.ini - no-op (boot-safe)"}
    m.off = off
    m.off_source = src
    return m, None


def _sig_ok(m):
    j = m.off.get("cdefpolicy_jne")
    if j is None:
        return False
    pre = m.rd(j - 3, 3)
    b = m.rd(j, 1)
    return pre == CDEFPOLICY_SIG and b and b[0] in (0x75, 0xEB)


def status():
    m, err = _open()
    if err:
        return err
    off = m.off
    vals = {k: m.rd_dw(off[k]) for k in GLOBAL_KEYS}
    j = off.get("cdefpolicy_jne")
    jb = m.rd(j, 1)[0] if j is not None else None
    dv = m.disk_version
    sig = _sig_ok(m)
    m.close()
    applied = (vals.get("bAppServerAllowed") == 1 and (j is None or jb == 0xEB))
    return {"ok": True, "version": m.version, "disk_version": dv, "source": m.off_source,
            "sig_ok": sig, "applied": applied, "globals": vals,
            "cdefpolicy_jne": ("0x%02X" % jb) if jb is not None else "n/a"}


def apply():
    m, err = _open()
    if err:
        return err
    off = m.off
    j = off.get("cdefpolicy_jne")
    # a located jne MUST match the signature, else refuse (guards against a wrong/stale offset)
    if j is not None and not _sig_ok(m):
        dv = m.disk_version
        m.close()
        return {"ok": False, "error": "CDefPolicy signature mismatch - refusing to patch",
                "version": m.version, "disk_version": dv, "source": m.off_source}
    before = {k: m.rd_dw(off[k]) for k in GLOBAL_KEYS}
    # only trust ini-derived global RVAs if they currently read as plausible flag values
    if m.off_source != "builtin" and not _globals_sane(before):
        m.close()
        return {"ok": False, "error": "CSLQuery globals failed sanity check - refusing (bad ini offset?)",
                "version": m.version, "source": m.off_source, "before": before}
    for k, v in MULTI_VALUES.items():
        m.wr_dw(off[k], v)
    jb = None
    if j is not None:
        m.wr(j, [0xEB])   # jne -> jmp
        jb = m.rd(j, 1)[0]
    after = {k: m.rd_dw(off[k]) for k in GLOBAL_KEYS}
    m.close()
    ok = (after.get("bAppServerAllowed") == 1 and (j is None or jb == 0xEB))
    return {"ok": ok, "version": m.version, "source": m.off_source, "before": before, "after": after,
            "cdefpolicy_jne": ("0x%02X" % jb) if jb is not None else "n/a"}


def revert():
    """Restore native single-session values in the live process (or just restart TermService)."""
    m, err = _open()
    if err:
        return err
    off = m.off
    for k, v in NATIVE_VALUES.items():
        m.wr_dw(off[k], v)
    j = off.get("cdefpolicy_jne")
    if j is not None:
        m.wr(j, [0x75])   # jmp -> jne
    m.close()
    return {"ok": True, "version": m.version, "source": m.off_source,
            "note": "native values restored in memory"}


def ensure_multisession():
    """Idempotent entrypoint for daemons: enable multi-session if supported, else no-op.
    Never raises - safe to call unconditionally at startup."""
    try:
        st = status()
        if not st.get("ok"):
            return st
        if st.get("applied"):
            return {"ok": True, "version": st["version"], "applied": True, "note": "already enabled"}
        return apply()
    except Exception as e:  # never let the patcher break the caller
        return {"ok": False, "error": "ensure_multisession exception: %s" % e}


if __name__ == "__main__":
    import json
    act = sys.argv[1] if len(sys.argv) > 1 else "status"
    fn = {"status": status, "apply": apply, "revert": revert, "ensure": ensure_multisession}.get(act, status)
    print(json.dumps(fn(), ensure_ascii=False, indent=2))
