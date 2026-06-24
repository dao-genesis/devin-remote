// 道法自然 · build — sucrase 转译 src/extension.ts → out/extension.js
// 帛书·「大巧若拙」: 不打包, 仅转译; ws/vscode 运行时解析 (vsce 随 node_modules 打包 ws)
const fs = require('fs');
const path = require('path');
const { transform } = require('sucrase');

const srcDir = path.join(__dirname, 'src');
const outDir = path.join(__dirname, 'out');
fs.mkdirSync(outDir, { recursive: true });

let count = 0;
for (const f of fs.readdirSync(srcDir)) {
    if (!f.endsWith('.ts')) continue;
    const code = fs.readFileSync(path.join(srcDir, f), 'utf8');
    const result = transform(code, {
        transforms: ['typescript', 'imports'],
        filePath: path.join(srcDir, f),
    });
    const outName = f.replace(/\.ts$/, '.js');
    fs.writeFileSync(path.join(outDir, outName), result.code);
    count++;
}
console.log('[build] transpiled ' + count + ' file(s) → out/');

// 帛书·「为之于其未有」: 桥代码是注入浏览器的字符串字面量, tsc/node --check 检不出其语法错。
// 故构建期抽取 daoDropBridgeJs() 拼接串以 new Function 实解析, 杜绝桥 JS 语法错蒙混过关。
try {
    const ext = fs.readFileSync(path.join(outDir, 'extension.js'), 'utf8');
    const i = ext.indexOf('function daoDropBridgeJs');
    if (i >= 0) {
        const seg = ext.slice(i, ext.indexOf('].join(', i) + 10);
        const arrLit = seg.slice(seg.indexOf('['), seg.lastIndexOf(']') + 1);
        // eslint-disable-next-line no-eval
        const parts = eval(arrLit);
        const bridge = parts.join('');
        new Function(bridge); // throws on syntax error
        console.log('[build] daoDropBridgeJs syntax OK (' + bridge.length + ' chars)');
    }
} catch (e) {
    console.error('[build] FATAL: daoDropBridgeJs syntax error → ' + e.message);
    process.exit(1);
}
