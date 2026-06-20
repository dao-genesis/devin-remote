// render_check.js · 校验 webview 内联脚本「渲染后」是否仍是合法 JS。
//
// 背景(见 cloud/coldstart/RUNBOOK_coldstart.md §4「webview 两大陷阱」)：dao-proxy-pro 的 webview HTML 由
// 反引号模板字符串生成。串内正则的单反斜杠(\/ \s)会在模板插值时被吞，导致渲染后的脚本语法错误、
// 整段 IIFE 抛错、面板卡「加载中」。node --check 只能查源文件，查不出「渲染后」的塌缩。
// 本脚本抽出每个 <script nonce> 块，模拟模板插值(还原 \uXXXX / \/ 折叠)，再 new vm.Script() 解析。
//
// 用法: node tools/render_check.js [path/to/extension.js]
//   默认: core/dao-proxy-pro/extension.js (相对仓库根)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const target = process.argv[2] ||
  path.join(__dirname, '..', 'core', 'dao-proxy-pro', 'extension.js');
const src = fs.readFileSync(target, 'utf8');

let failures = 0;

// 括号感知地剥离 ${...} 模板插值(替换为 0)。朴素的 /\$\{[^}]*\}/ 遇到内含 { 的插值
// (如 ${JSON.stringify(x||{a:1})} 或 ${c?`{...}`:''})会在第一个 } 截断, 误报 PARSE FAILED。
function stripInterp(s) {
  let out = '', i = 0;
  while (i < s.length) {
    if (s[i] === '$' && s[i + 1] === '{') {
      let depth = 1, j = i + 2;
      while (j < s.length && depth > 0) { if (s[j] === '{') depth++; else if (s[j] === '}') depth--; j++; }
      out += '0'; i = j;
    } else { out += s[i]; i++; }
  }
  return out;
}

function renderScripts(label, startMarker) {
  const fi = src.indexOf(startMarker);
  if (fi < 0) { console.log(label, 'FUNC NOT FOUND'); return; }
  const region = src.slice(fi, fi + 200000);
  const re = /<script nonce="\$\{[^}]*\}"\s*>([\s\S]*?)<\/script>/g;
  let m, n = 0;
  while ((m = re.exec(region))) {
    n++;
    const placeheld = stripInterp(m[1]);
    let rendered;
    try {
      // 反引号包裹 eval -> 处理转义与模板插值完全一致
      rendered = vm.runInNewContext('`' + placeheld.replace(/`/g, '\\`') + '`');
    } catch (e) {
      console.log(label, 'script#' + n, 'TEMPLATE-RENDER FAILED:', e.message);
      failures++; continue;
    }
    try {
      new vm.Script(rendered);
      console.log(label, 'script#' + n, 'RENDERED + PARSED OK (', rendered.length, 'chars )');
    } catch (e) {
      console.log(label, 'script#' + n, 'PARSE FAILED:', e.message);
      failures++;
    }
  }
  if (n === 0) console.log(label, 'no <script nonce> blocks found');
}

renderScripts('getEssenceHtml', 'function getEssenceHtml(');
renderScripts('getEaConfigHtml', 'function getEaConfigHtml(');

// /shell 归一外壳客户端脚本用无 nonce 的 <script>，单独以同样的模板插值+解析校验。
function renderPlainScripts(label, startMarker) {
  const fi = src.indexOf(startMarker);
  if (fi < 0) return; // 该构建无此函数(如 dao-proxy-pro)则跳过
  const region = src.slice(fi);
  const re = /<script>([\s\S]*?)<\/script>/g;
  let m, n = 0;
  while ((m = re.exec(region))) {
    n++;
    const placeheld = stripInterp(m[1]);
    let rendered;
    try {
      rendered = vm.runInNewContext('`' + placeheld.replace(/`/g, '\\`') + '`');
    } catch (e) {
      console.log(label, 'script#' + n, 'TEMPLATE-RENDER FAILED:', e.message);
      failures++; continue;
    }
    try {
      new vm.Script(rendered);
      console.log(label, 'script#' + n, 'RENDERED + PARSED OK (', rendered.length, 'chars )');
    } catch (e) {
      console.log(label, 'script#' + n, 'PARSE FAILED:', e.message);
      failures++;
    }
  }
}
renderPlainScripts('_multiShellHtml', 'function _multiShellHtml(');
// dao-vsix 六合一中间面板(getDaoCloudMiddlePanelHtml)亦为反引号模板内联 <script>,
// 其客户端脚本含 rComputer 等; 运行: node tools/render_check.js core/dao-vsix/out/extension.js
renderPlainScripts('getDaoCloudMiddlePanelHtml', 'function getDaoCloudMiddlePanelHtml(');

process.exit(failures ? 1 : 0);
