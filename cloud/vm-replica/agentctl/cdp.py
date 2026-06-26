"""agentctl.cdp — a minimal, zero-dependency Chrome DevTools Protocol client.

This is the *action half* of the vm-replica work: where ``agent-vm`` learns to
**see** the GUI (motion / flow / region parsing), ``agentctl`` learns to **act**
on it the way a human does, and grows its architecture from real friction rather
than up-front design (反者道之动 — operate first, let the structure emerge).

Why hand-roll the WebSocket?  Chrome's CDP endpoint speaks WebSocket, but the VM
ships no ``websocket-client``.  Rather than take a network dependency that future
snapshots / CI might lack, we implement just enough of RFC 6455 (client masking,
the three payload-length forms, ping/pong, close, continuation) over a plain
socket to localhost.  No TLS, no proxies — it is a loopback to our own browser.

Design notes earned from friction (see JOURNAL.md):

* **F006 — dialog self-deadlock.** ``Runtime.evaluate`` of code that opens an
  ``alert()``/``confirm()``/``prompt()`` never returns until the dialog is
  handled; if the *same* thread is blocked waiting for that reply, nothing can
  ever send ``Page.handleJavaScriptDialog`` → hard deadlock.  The fix baked in
  here is a **background receiver thread**: events (incl. ``javascriptDialog
  Opening``) are dispatched off-thread, so a dialog can be handled while a
  command future is still pending.
* **F008 — cross-frame execution context.** We track
  ``Runtime.executionContextCreated`` so higher layers can evaluate *inside* an
  iframe's context instead of only the top frame.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import socket
import struct
import threading
import time
import urllib.request

DEFAULT_PORT = 29229


class CDPError(RuntimeError):
    """A CDP command returned an error, or the protocol misbehaved."""


# --------------------------------------------------------------------------- #
# Minimal RFC 6455 WebSocket client (text frames, client->server masked).      #
# --------------------------------------------------------------------------- #
class _WS:
    _GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

    def __init__(self, host: str, port: int, path: str, timeout: float = 30.0):
        self.sock = socket.create_connection((host, port), timeout=timeout)
        self.sock.settimeout(timeout)
        self._buf = b""
        self._send_lock = threading.Lock()
        self._handshake(host, port, path)

    def _handshake(self, host: str, port: int, path: str) -> None:
        key = base64.b64encode(os.urandom(16)).decode()
        req = (
            f"GET {path} HTTP/1.1\r\n"
            f"Host: {host}:{port}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n\r\n"
        )
        self.sock.sendall(req.encode())
        # Read headers up to the blank line.
        while b"\r\n\r\n" not in self._buf:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise CDPError("WebSocket handshake closed early")
            self._buf += chunk
        head, self._buf = self._buf.split(b"\r\n\r\n", 1)
        status = head.split(b"\r\n", 1)[0]
        if b"101" not in status:
            raise CDPError(f"WebSocket handshake failed: {status!r}")
        accept = base64.b64encode(
            hashlib.sha1((key + self._GUID).encode()).digest()
        ).decode()
        if accept.encode() not in head:
            raise CDPError("WebSocket handshake: bad Sec-WebSocket-Accept")

    def _recv_exactly(self, n: int) -> bytes:
        while len(self._buf) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise CDPError("WebSocket connection closed")
            self._buf += chunk
        out, self._buf = self._buf[:n], self._buf[n:]
        return out

    def send_text(self, data: str) -> None:
        payload = data.encode("utf-8")
        header = bytearray([0x81])  # FIN + text opcode
        mask = os.urandom(4)
        n = len(payload)
        if n < 126:
            header.append(0x80 | n)
        elif n < 65536:
            header.append(0x80 | 126)
            header += struct.pack(">H", n)
        else:
            header.append(0x80 | 127)
            header += struct.pack(">Q", n)
        header += mask
        masked = bytes(b ^ mask[i & 3] for i, b in enumerate(payload))
        with self._send_lock:
            self.sock.sendall(bytes(header) + masked)

    def _send_frame(self, opcode: int, payload: bytes = b"") -> None:
        header = bytearray([0x80 | opcode])
        mask = os.urandom(4)
        header.append(0x80 | len(payload))
        header += mask
        masked = bytes(b ^ mask[i & 3] for i, b in enumerate(payload))
        with self._send_lock:
            self.sock.sendall(bytes(header) + masked)

    def recv_text(self) -> str:
        """Return the next complete text message, transparently handling
        control frames (ping/pong/close) and fragmentation."""
        chunks: list[bytes] = []
        while True:
            b0, b1 = self._recv_exactly(2)
            fin = b0 & 0x80
            opcode = b0 & 0x0F
            masked = b1 & 0x80
            length = b1 & 0x7F
            if length == 126:
                (length,) = struct.unpack(">H", self._recv_exactly(2))
            elif length == 127:
                (length,) = struct.unpack(">Q", self._recv_exactly(8))
            mask = self._recv_exactly(4) if masked else b""
            data = self._recv_exactly(length)
            if masked:
                data = bytes(b ^ mask[i & 3] for i, b in enumerate(data))

            if opcode == 0x8:  # close
                raise CDPError("WebSocket closed by peer")
            if opcode == 0x9:  # ping -> pong
                self._send_frame(0xA, data)
                continue
            if opcode == 0xA:  # pong
                continue
            # text (0x1) or continuation (0x0)
            chunks.append(data)
            if fin:
                return b"".join(chunks).decode("utf-8", "replace")

    def close(self) -> None:
        try:
            self._send_frame(0x8)
        except Exception:
            pass
        try:
            self.sock.close()
        except Exception:
            pass


# --------------------------------------------------------------------------- #
# CDP session: command/response correlation + background event pump.           #
# --------------------------------------------------------------------------- #
class CDP:
    def __init__(self, port: int = DEFAULT_PORT, host: str = "127.0.0.1"):
        self.host = host
        self.port = port
        self.ws: _WS | None = None
        self._id = 0
        self._id_lock = threading.Lock()
        self._pending: dict[int, dict] = {}
        self._pending_lock = threading.Lock()
        self._listeners: dict[str, list] = {}
        self._reader: threading.Thread | None = None
        self._alive = False
        # F008: execution-context bookkeeping (contextId -> info dict).
        self.contexts: dict[int, dict] = {}
        # F006: most recent JS dialog + optional auto-handling policy.
        self.last_dialog: dict | None = None
        self.auto_dialog: dict | None = None  # e.g. {"accept": True, "text": ""}
        self.events: list[dict] = []  # bounded ring of recent events (debugging)

    # ---- discovery -------------------------------------------------------- #
    def _http_json(self, path: str):
        url = f"http://{self.host}:{self.port}{path}"
        with urllib.request.urlopen(url, timeout=10) as r:
            return json.loads(r.read().decode())

    def list_pages(self) -> list[dict]:
        return [t for t in self._http_json("/json") if t.get("type") == "page"]

    def new_page(self, url: str = "about:blank") -> dict:
        """Open a fresh tab (F007: a clean page escapes a wedged renderer)."""
        return self._http_json(f"/json/new?{url}")

    # ---- connection ------------------------------------------------------- #
    def connect(self, ws_url: str | None = None, want_url: str | None = None) -> "CDP":
        if ws_url is None:
            pages = self.list_pages()
            if not pages:
                pages = [self.new_page("about:blank")]
            chosen = pages[0]
            if want_url:
                for p in pages:
                    if want_url in p.get("url", ""):
                        chosen = p
                        break
            ws_url = chosen["webSocketDebuggerUrl"]
        # ws://127.0.0.1:PORT/devtools/page/<id>
        rest = ws_url.split("://", 1)[1]
        hostport, path = rest.split("/", 1)
        host = hostport.split(":")[0]
        port = int(hostport.split(":")[1]) if ":" in hostport else 80
        self.ws = _WS(host, port, "/" + path)
        self._alive = True
        self._reader = threading.Thread(target=self._read_loop, daemon=True)
        self._reader.start()
        self.on_event("Runtime.executionContextCreated", self._on_ctx_created)
        self.on_event("Runtime.executionContextDestroyed", self._on_ctx_destroyed)
        self.on_event("Runtime.executionContextsCleared", lambda p: self.contexts.clear())
        self.on_event("Page.javascriptDialogOpening", self._on_dialog)
        self.call("Page.enable")
        self.call("Runtime.enable")
        self.call("DOM.enable")
        return self

    # ---- event pump ------------------------------------------------------- #
    def _read_loop(self) -> None:
        while self._alive:
            try:
                raw = self.ws.recv_text()
            except Exception:
                self._alive = False
                self._fail_all_pending()
                return
            try:
                msg = json.loads(raw)
            except Exception:
                continue
            mid = msg.get("id")
            if mid is not None:
                with self._pending_lock:
                    slot = self._pending.get(mid)
                if slot is not None:
                    slot["msg"] = msg
                    slot["event"].set()
                continue
            # protocol event
            method = msg.get("method", "")
            params = msg.get("params", {})
            self.events.append(msg)
            if len(self.events) > 500:
                self.events = self.events[-500:]
            for cb in list(self._listeners.get(method, ())):
                try:
                    cb(params)
                except Exception:
                    pass

    def _fail_all_pending(self) -> None:
        with self._pending_lock:
            for slot in self._pending.values():
                slot["msg"] = {"error": {"message": "connection closed"}}
                slot["event"].set()
            self._pending.clear()

    def on_event(self, method: str, cb) -> None:
        self._listeners.setdefault(method, []).append(cb)

    # ---- command/response ------------------------------------------------- #
    def send(self, method: str, params: dict | None = None,
             session_id: str | None = None) -> int:
        """Fire-and-forget: write a command frame without awaiting its reply.

        Required for handlers that run *on the reader thread* (e.g. JS dialog
        auto-accept). Such a handler must never call ``call()``, which would
        block waiting for a reply that only the reader thread can deliver --
        i.e. the thread would wait on itself (F006 deadlock).
        """
        if not self._alive:
            raise CDPError("CDP not connected")
        with self._id_lock:
            self._id += 1
            mid = self._id
        frame = {"id": mid, "method": method, "params": params or {}}
        if session_id:
            frame["sessionId"] = session_id
        self.ws.send_text(json.dumps(frame))
        return mid

    def call(self, method: str, params: dict | None = None, timeout: float = 20.0,
             session_id: str | None = None) -> dict:
        if not self._alive:
            raise CDPError("CDP not connected")
        with self._id_lock:
            self._id += 1
            mid = self._id
        frame = {"id": mid, "method": method, "params": params or {}}
        if session_id:
            frame["sessionId"] = session_id
        slot = {"event": threading.Event(), "msg": None}
        with self._pending_lock:
            self._pending[mid] = slot
        self.ws.send_text(json.dumps(frame))
        if not slot["event"].wait(timeout):
            with self._pending_lock:
                self._pending.pop(mid, None)
            raise CDPError(f"CDP timeout after {timeout}s: {method}")
        with self._pending_lock:
            self._pending.pop(mid, None)
        msg = slot["msg"] or {}
        if "error" in msg:
            raise CDPError(f"{method}: {msg['error']}")
        return msg.get("result", {})

    # ---- F008: execution contexts ---------------------------------------- #
    def _on_ctx_created(self, params: dict) -> None:
        ctx = params.get("context", {})
        cid = ctx.get("id")
        if cid is not None:
            self.contexts[cid] = ctx

    def _on_ctx_destroyed(self, params: dict) -> None:
        self.contexts.pop(params.get("executionContextId"), None)

    # ---- F006: JS dialogs ------------------------------------------------- #
    def _on_dialog(self, params: dict) -> None:
        self.last_dialog = dict(params)
        if self.auto_dialog is not None:
            try:
                # Runs on the reader thread -> must be fire-and-forget (F006).
                self.handle_dialog(
                    accept=self.auto_dialog.get("accept", True),
                    text=self.auto_dialog.get("text", ""),
                    wait=False,
                )
            except Exception:
                pass

    def handle_dialog(self, accept: bool = True, text: str = "",
                      wait: bool = True) -> None:
        params = {"accept": accept}
        if text:
            params["promptText"] = text
        if wait:
            self.call("Page.handleJavaScriptDialog", params)
        else:
            self.send("Page.handleJavaScriptDialog", params)

    # ---- convenience ------------------------------------------------------ #
    def evaluate(self, expression: str, await_promise: bool = False,
                 return_by_value: bool = True, context_id: int | None = None,
                 timeout: float = 20.0):
        params = {
            "expression": expression,
            "returnByValue": return_by_value,
            "awaitPromise": await_promise,
        }
        if context_id is not None:
            params["contextId"] = context_id
        res = self.call("Runtime.evaluate", params, timeout=timeout)
        if res.get("exceptionDetails"):
            exc = res["exceptionDetails"]
            msg = exc.get("exception", {}).get("description") or exc.get("text")
            raise CDPError(f"JS exception: {msg}")
        return res.get("result", {}).get("value")

    def close(self) -> None:
        self._alive = False
        if self.ws:
            self.ws.close()


if __name__ == "__main__":
    c = CDP().connect()
    print("connected; UA:", c.evaluate("navigator.userAgent"))
    print("title:", c.evaluate("document.title"))
    print("contexts:", list(c.contexts))
    c.close()
