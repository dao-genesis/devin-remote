#!/usr/bin/env python3
"""
dao-vm-agent — in-session control server for a background Windows RDP session.

Philosophy (外固其本·内圆其心): give a cloud Agent the same smooth, VM-like control
over a *background* Windows account on the user's machine as it has over its own
Devin Cloud VM — screen capture, mouse, keyboard, recording — fully isolated from
the user's foreground (console) session.

This process MUST run *inside* the target session (the dedicated agent account's
RDP session). It binds 127.0.0.1 only; the dao-bridge extension proxies
`/api/vm/*` from the public tunnel to this port, so an external Agent reuses the
existing tunnel + Bearer token. It never touches the user's console session.

Pure-Python stack (already present on the target): mss, pyautogui, opencv, PIL,
numpy, pywin32. No ffmpeg required.
"""
import os
import io
import sys
import json
import time
import threading
import ctypes
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import mss
import numpy as np
import pyautogui

try:
    import cv2
except Exception:  # recording is optional
    cv2 = None

pyautogui.FAILSAFE = False
pyautogui.PAUSE = 0.0

VERSION = "1.0.0"
HOST = "127.0.0.1"
PORT = int(os.environ.get("DAO_VM_PORT", "9921"))
TOKEN = os.environ.get("DAO_VM_TOKEN", "9dd1db47b078638b2d5196c8384edfe4")
REC_DIR = os.path.join(os.path.expanduser("~"), ".dao", "vm-rec")
os.makedirs(REC_DIR, exist_ok=True)


def session_info():
    """WTS session id + console session id (to prove isolation from the user)."""
    try:
        k32 = ctypes.windll.kernel32
        wts = ctypes.windll.wtsapi32
        pid = k32.GetCurrentProcessId()
        sid = ctypes.c_ulong(0)
        k32.ProcessIdToSessionId(pid, ctypes.byref(sid))
        console = wts.WTSGetActiveConsoleSessionId()
        return {"pid": pid, "session_id": int(sid.value), "console_session_id": int(console)}
    except Exception as e:
        return {"error": str(e)}


class Recorder:
    def __init__(self):
        self.thread = None
        self.running = False
        self.path = None
        self.frames = 0
        self.started = 0.0
        self.fps = 12
        self.lock = threading.Lock()

    def start(self, fps=12, name=None, monitor=1):
        with self.lock:
            if self.running:
                return {"ok": False, "error": "already recording", "path": self.path}
            if cv2 is None:
                return {"ok": False, "error": "opencv not available"}
            name = name or time.strftime("rec_%Y%m%d_%H%M%S.mp4")
            self.path = os.path.join(REC_DIR, name)
            self.fps = max(1, min(30, int(fps)))
            self.frames = 0
            self.running = True
            self.started = time.time()
            self.thread = threading.Thread(target=self._loop, args=(monitor,), daemon=True)
            self.thread.start()
            return {"ok": True, "path": self.path, "fps": self.fps}

    def _loop(self, monitor):
        with mss.mss() as sct:
            mon = sct.monitors[monitor if monitor < len(sct.monitors) else 1]
            w, h = mon["width"], mon["height"]
            fourcc = cv2.VideoWriter_fourcc(*"mp4v")
            writer = cv2.VideoWriter(self.path, fourcc, self.fps, (w, h))
            interval = 1.0 / self.fps
            nxt = time.time()
            while self.running:
                img = np.array(sct.grab(mon))  # BGRA
                frame = cv2.cvtColor(img, cv2.COLOR_BGRA2BGR)
                writer.write(frame)
                self.frames += 1
                nxt += interval
                sleep = nxt - time.time()
                if sleep > 0:
                    time.sleep(sleep)
                else:
                    nxt = time.time()
            writer.release()

    def stop(self):
        with self.lock:
            if not self.running:
                return {"ok": False, "error": "not recording"}
            self.running = False
        if self.thread:
            self.thread.join(timeout=5)
        return {"ok": True, "path": self.path, "frames": self.frames,
                "seconds": round(time.time() - self.started, 2)}


REC = Recorder()


def grab_png(monitor=1):
    with mss.mss() as sct:
        mon = sct.monitors[monitor if monitor < len(sct.monitors) else 1]
        raw = sct.grab(mon)
        from PIL import Image
        img = Image.frombytes("RGB", raw.size, raw.bgra, "raw", "BGRX")
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        return buf.getvalue(), raw.size


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _auth(self):
        if self.path.rstrip("/").endswith("/health"):
            return True
        return self.headers.get("Authorization", "") == "Bearer " + TOKEN

    def _json(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(b)

    def _bin(self, code, ctype, data):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(data)

    def _body(self):
        n = int(self.headers.get("Content-Length", 0) or 0)
        if not n:
            return {}
        try:
            return json.loads(self.rfile.read(n) or b"{}")
        except Exception:
            return {}

    def _path(self):
        return self.path.split("?", 1)[0].rstrip("/") or "/"

    def _query(self):
        if "?" not in self.path:
            return {}
        from urllib.parse import parse_qs
        return {k: v[0] for k, v in parse_qs(self.path.split("?", 1)[1]).items()}

    def do_GET(self):
        if not self._auth():
            return self._json(401, {"error": "unauthorized"})
        p = self._path()
        q = self._query()
        try:
            if p.endswith("/health"):
                w, h = pyautogui.size()
                return self._json(200, {"ok": True, "service": "dao-vm-agent", "version": VERSION,
                                        "screen": [w, h], **session_info()})
            if p.endswith("/screenshot"):
                mon = int(q.get("monitor", "1"))
                data, size = grab_png(mon)
                return self._bin(200, "image/png", data)
            if p.endswith("/mouse"):
                x, y = pyautogui.position()
                return self._json(200, {"x": x, "y": y})
            if p.endswith("/record/file"):
                name = q.get("name")
                fp = os.path.join(REC_DIR, os.path.basename(name)) if name else (REC.path or "")
                if not fp or not os.path.exists(fp):
                    return self._json(404, {"error": "no recording", "path": fp})
                with open(fp, "rb") as f:
                    return self._bin(200, "video/mp4", f.read())
            return self._json(404, {"error": "not found", "path": p})
        except Exception as e:
            return self._json(500, {"error": str(e)})

    def do_POST(self):
        if not self._auth():
            return self._json(401, {"error": "unauthorized"})
        p = self._path()
        j = self._body()
        try:
            if p.endswith("/move"):
                pyautogui.moveTo(int(j["x"]), int(j["y"]), duration=float(j.get("duration", 0)))
                return self._json(200, {"ok": True, "pos": list(pyautogui.position())})
            if p.endswith("/click"):
                kw = {"button": j.get("button", "left"), "clicks": int(j.get("clicks", 1)),
                      "interval": float(j.get("interval", 0.0))}
                if "x" in j and "y" in j:
                    kw["x"], kw["y"] = int(j["x"]), int(j["y"])
                pyautogui.click(**kw)
                return self._json(200, {"ok": True, "pos": list(pyautogui.position())})
            if p.endswith("/doubleclick"):
                pyautogui.doubleClick(x=int(j["x"]), y=int(j["y"])) if "x" in j else pyautogui.doubleClick()
                return self._json(200, {"ok": True})
            if p.endswith("/rightclick"):
                pyautogui.rightClick(x=int(j["x"]), y=int(j["y"])) if "x" in j else pyautogui.rightClick()
                return self._json(200, {"ok": True})
            if p.endswith("/drag"):
                pyautogui.moveTo(int(j["x1"]), int(j["y1"]))
                pyautogui.dragTo(int(j["x2"]), int(j["y2"]), duration=float(j.get("duration", 0.3)),
                                 button=j.get("button", "left"))
                return self._json(200, {"ok": True})
            if p.endswith("/scroll"):
                pyautogui.scroll(int(j.get("amount", 0)))
                return self._json(200, {"ok": True})
            if p.endswith("/type"):
                pyautogui.typewrite(str(j.get("text", "")), interval=float(j.get("interval", 0.0)))
                return self._json(200, {"ok": True})
            if p.endswith("/key"):
                keys = j.get("keys")
                if isinstance(keys, list) and keys:
                    pyautogui.hotkey(*keys)
                elif j.get("press"):
                    pyautogui.press(str(j["press"]))
                else:
                    return self._json(400, {"error": "provide keys[] or press"})
                return self._json(200, {"ok": True})
            if p.endswith("/record/start"):
                return self._json(200, REC.start(fps=int(j.get("fps", 12)), name=j.get("name"),
                                                 monitor=int(j.get("monitor", 1))))
            if p.endswith("/record/stop"):
                return self._json(200, REC.stop())
            return self._json(404, {"error": "not found", "path": p})
        except KeyError as e:
            return self._json(400, {"error": "missing field " + str(e)})
        except Exception as e:
            return self._json(500, {"error": str(e)})


def main():
    si = session_info()
    sys.stdout.write("dao-vm-agent %s listening on %s:%d  session=%s console=%s\n" % (
        VERSION, HOST, PORT, si.get("session_id"), si.get("console_session_id")))
    sys.stdout.flush()
    ThreadingHTTPServer((HOST, PORT), H).serve_forever()


if __name__ == "__main__":
    main()
