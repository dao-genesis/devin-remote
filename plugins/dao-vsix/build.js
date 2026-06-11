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
