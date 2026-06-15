"use strict";
// 换登流程的共享类型：日志回调、配置、结果、暂停/停止开关。
// 这些是从 Python 后端（vwdevin.automation / vwdevin.storage）1:1 翻过来的，
// 但改成纯客户端、in-process 的 async 形态——不再有子进程 / NDJSON 中转。
Object.defineProperty(exports, "__esModule", { value: true });
exports.PauseGate = exports.StopRequested = void 0;
exports.ok = ok;
exports.fail = fail;
function ok(finalUrl = "") {
    return { success: true, error: "", finalUrl };
}
function fail(error, finalUrl = "") {
    return { success: false, error, finalUrl };
}
/** 用户点 "取消" 时内部抛出，用来中断整条流程（对应 Python `StopRequested`）。 */
class StopRequested extends Error {
    constructor() {
        super("stopped");
        this.name = "StopRequested";
    }
}
exports.StopRequested = StopRequested;
/**
 * 暂停 / 继续 / 停止开关，对应 Python 的 `PauseGate`。
 *
 * Python 版用 `threading.Event` 在 worker 线程和 GUI 线程之间同步；这里换登
 * 跑在扩展宿主的单线程事件循环里，所以改成 Promise：`pauseAndWait` 返回一个
 * 在 `resume()` / `stop()` 被调用时 resolve 的 Promise。`onWaitingChange`
 * 回调让 Webview 能在暂停时亮出 "继续" 按钮。
 */
class PauseGate {
    constructor(onWaitingChange) {
        this.onWaitingChange = onWaitingChange;
        this.stopped = false;
        this.waiting = false;
        this.reason = "";
    }
    async pauseAndWait(reason, log) {
        this.reason = reason;
        this.waiting = true;
        this.onWaitingChange?.(true, reason);
        log(`⏸  已暂停：${reason}`);
        log("    准备好后请点窗口里的 '继续'。");
        await new Promise((resolve) => {
            this.resumeResolve = resolve;
            // 极小概率：挂监听前就已经被 stop，立即放行。
            if (this.stopped) {
                resolve();
            }
        });
        this.resumeResolve = undefined;
        this.waiting = false;
        this.reason = "";
        this.onWaitingChange?.(false, "");
        if (this.stopped) {
            throw new StopRequested();
        }
        log("▶  已继续。");
    }
    resume() {
        this.resumeResolve?.();
    }
    stop() {
        this.stopped = true;
        // 把可能卡在 pauseAndWait 的 Promise 放出来。
        this.resumeResolve?.();
    }
    isWaiting() {
        return this.waiting;
    }
    isStopped() {
        return this.stopped;
    }
    /** 已被 stop 就抛 `StopRequested`，用在各步骤之间的 "安全点"。 */
    checkStop() {
        if (this.stopped) {
            throw new StopRequested();
        }
    }
}
exports.PauseGate = PauseGate;
//# sourceMappingURL=types.js.map