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

        connect: function (vm) {
            var self = this;
            var proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            var url = proto + '//' + window.location.host + '/rdp?vm=' + encodeURIComponent(vm);
            this.ws = new WebSocket(url);
            this.ws.onopen = function () { self.status('握手 · 协商 RDP…'); };
            this.ws.onmessage = function (ev) {
                var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
                if (m.e === 'rdp-connect') { self.active = true; self.status(''); if (self.statusEl) self.statusEl.style.display = 'none'; }
                else if (m.e === 'rdp-bitmap') { m.b.data = b64ToU8(m.b.data); self.render.update(m.b); }
                else if (m.e === 'rdp-close') { self.active = false; self.status('会话已断开'); if (self.statusEl) self.statusEl.style.display = 'block'; }
                else if (m.e === 'rdp-error') { self.active = false; self.status('RDP 错误: ' + (m.m || '')); if (self.statusEl) self.statusEl.style.display = 'block'; }
            };
            this.ws.onclose = function () { self.active = false; };
            this.ws.onerror = function () { self.status('网关连接失败'); };
        }
    };

    Mstsc.wsclient = { create: function (canvas, statusEl) { return new WsClient(canvas, statusEl); } };
})();
