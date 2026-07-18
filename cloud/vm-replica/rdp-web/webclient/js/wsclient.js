/*
 * wsclient.js · rdp-web WebSocket 传输层
 *
 * 承袭官方 mstsc.js client.js 的输入绑定与渲染调用(Mstsc.Canvas + Mstsc.scancode),
 * 仅把 socket.io 传输替换为原生 WebSocket, 以适配 IDE Webview iframe 内页。
 * 位图数据经 base64 传输, 交由官方 canvas.js/rle.js 解压渲染, 与原生 RDP 帧路径一致。
 */
(function () {
    function mouseButtonMap(button) {
        switch (button) {
            case 0: return 1;
            case 2: return 2;
            default: return 0;
        }
    }

    function b64ToU8(b64) {
        var bin = atob(b64);
        var u8 = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
        return u8;
    }

    function WsClient(canvas, statusEl) {
        this.canvas = canvas;
        this.statusEl = statusEl;
        this.render = Mstsc.Canvas.create(canvas);
        this.ws = null;
        this.active = false;
        this.vm = null;
        this.closed = false;
        this.retry = 0;
        this._reT = null;
        this.install();
    }

    WsClient.prototype = {
        status: function (t) { if (this.statusEl) this.statusEl.textContent = t; },
        emit: function (o) { try { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(o)); } catch (e) {} },

        install: function () {
            var self = this;
            var c = this.canvas;
            c.addEventListener('mousemove', function (e) {
                if (!self.active) return;
                var o = Mstsc.elementOffset(c);
                self.emit({ t: 'mouse', x: (e.clientX - o.left) | 0, y: (e.clientY - o.top) | 0, button: 0, pressed: false });
                e.preventDefault(); return false;
            });
            c.addEventListener('mousedown', function (e) {
                if (!self.active) return;
                var o = Mstsc.elementOffset(c);
                self.emit({ t: 'mouse', x: (e.clientX - o.left) | 0, y: (e.clientY - o.top) | 0, button: mouseButtonMap(e.button), pressed: true });
                c.focus(); e.preventDefault(); return false;
            });
            c.addEventListener('mouseup', function (e) {
                if (!self.active) return;
                var o = Mstsc.elementOffset(c);
                self.emit({ t: 'mouse', x: (e.clientX - o.left) | 0, y: (e.clientY - o.top) | 0, button: mouseButtonMap(e.button), pressed: false });
                e.preventDefault(); return false;
            });
            c.addEventListener('contextmenu', function (e) { e.preventDefault(); return false; });
            c.addEventListener('wheel', function (e) {
                if (!self.active) return;
                var horiz = Math.abs(e.deltaX) > Math.abs(e.deltaY);
                var delta = horiz ? e.deltaX : e.deltaY;
                var step = Math.round(Math.abs(delta) * 15 / 8);
                var o = Mstsc.elementOffset(c);
                self.emit({ t: 'wheel', x: (e.clientX - o.left) | 0, y: (e.clientY - o.top) | 0, step: step, neg: delta > 0, horiz: horiz });
                e.preventDefault(); return false;
            });
            c.addEventListener('keydown', function (e) {
                if (!self.active) return;
                self.emit({ t: 'scancode', code: Mstsc.scancode(e), pressed: true });
                e.preventDefault(); return false;
            });
            c.addEventListener('keyup', function (e) {
                if (!self.active) return;
                self.emit({ t: 'scancode', code: Mstsc.scancode(e), pressed: false });
                e.preventDefault(); return false;
            });
            return this;
        },

        // 道法自然 · 单壳一切: 复制品桌面折入归一外壳同级标签后, 决不因网关未就绪/会话短暂断开
        //   而变空屏/死页 — 恒自愈重连(退避 1s→8s), 标签内实时显「连接中·自动重连」态直至同源共控。
        _showStatus: function (t) { this.status(t); if (this.statusEl) this.statusEl.style.display = 'block'; },
        _scheduleReconnect: function () {
            var self = this;
            if (self.closed) return;
            if (self._reT) return;
            self.retry++;
            var delay = Math.min(8000, 1000 * self.retry);
            self._showStatus('连接中 · 自动重连 (' + self.retry + ')…');
            self._reT = setTimeout(function () { self._reT = null; self._open(); }, delay);
        },
        connect: function (vm) {
            this.vm = vm;
            this.closed = false;
            this.retry = 0;
            this._open();
        },
        close: function () {
            this.closed = true;
            if (this._reT) { clearTimeout(this._reT); this._reT = null; }
            try { if (this.ws) this.ws.close(); } catch (e) {}
        },
        _open: function () {
            var self = this;
            if (self.closed) return;
            var proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            var url = proto + '//' + window.location.host + '/rdp?vm=' + encodeURIComponent(self.vm);
            self._showStatus(self.retry ? ('连接中 · 自动重连 (' + self.retry + ')…') : '连接复制品会话…');
            var ws;
            try { ws = new WebSocket(url); } catch (e) { self._scheduleReconnect(); return; }
            this.ws = ws;
            ws.onopen = function () { self.retry = 0; self.status('握手 · 协商 RDP…'); };
            ws.onmessage = function (ev) {
                var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
                if (m.e === 'rdp-connect') { self.active = true; self.status(''); if (self.statusEl) self.statusEl.style.display = 'none'; }
                else if (m.e === 'rdp-bitmap') { m.b.data = b64ToU8(m.b.data); self.render.update(m.b); }
                else if (m.e === 'rdp-close') { self.active = false; self._showStatus('会话已断开 · 自动重连…'); }
                else if (m.e === 'rdp-error') { self.active = false; self._showStatus('RDP 错误: ' + (m.m || '') + ' · 自动重连…'); }
            };
            ws.onclose = function () { self.active = false; if (self.ws === ws) self.ws = null; self._scheduleReconnect(); };
            ws.onerror = function () { self.active = false; };
        }
    };

    Mstsc.wsclient = { create: function (canvas, statusEl) { return new WsClient(canvas, statusEl); } };
})();
