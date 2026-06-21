// —— UV JS 重写器「标签误伤」修复 (本源重构 · Path SW) ——
// 病灶: Ultraviolet 的 JS 重写器把 window 代理全局名(top/parent/self…)无条件包成
//   `__uv.$get(name)`。但当这些名字被当作【语句标签】时——现代打包器(如 alien-signals
//   的 `top: do {…} continue top`)会原样保留短标签名——就被错改成
//   `__uv.$get(top):do{…}` / `continue __uv.$get(top)` → SyntaxError: Unexpected token ':'.
//   单个被毁的 chunk 会令整张 React 模块图编译失败 → SPA 永远停在 spinner。
// 修法: 仅在两类【确定无歧义】上下文还原:
//   1) continue/break 之后只能是标签, 绝不可能是表达式 → 无条件还原;
//   2) 语句边界(; { } ) 行首)之后、紧跟 do/for/while/switch/{ 的 `__uv.$get(name):` 标签声明。
//   (三元 `a?__uv.$get(top):b` 的 `:` 前驱是 `?`, 不在边界集内 → 不误伤真实 window.top 访问。)
(function (root) {
  function repairUvJs(src) {
    if (!src || src.indexOf("__uv.$get(") === -1) return src;
    src = src.replace(/\b(continue|break)\s+__uv\.\$get\(([A-Za-z_$][\w$]*)\)/g, "$1 $2");
    src = src.replace(/([;{}\)]|^)(\s*)__uv\.\$get\(([A-Za-z_$][\w$]*)\):(\s*(?:do|for|while|switch)\b|\s*\{)/g, "$1$2$3:$4");
    return src;
  }
  root.repairUvJs = repairUvJs;
  if (typeof module !== "undefined" && module.exports) module.exports = { repairUvJs };
})(typeof self !== "undefined" ? self : globalThis);
