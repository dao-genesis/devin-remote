#!/usr/bin/env python3
"""把 rt-flow engine 静态壳目录 pin 到 Pinata, 取确定性 CIDv1 内容寻址。
用于 .github/workflows/pin-console-host.yml 发版自动重 pin。
读环境变量 PINATA_JWT。成功时 stdout 打印含 IpfsHash 的 JSON(供 workflow 解析 CID)。
"""
import os, re, json, urllib.request, ssl, uuid, sys

JWT = os.environ.get("PINATA_JWT", "").strip()
if not JWT:
    print("PINATA_JWT missing", file=sys.stderr); sys.exit(2)

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ENGINE = os.path.join(REPO_ROOT, "addons", "rt-flow-app", "app", "src", "main", "assets", "engine")
ctx = ssl.create_default_context()

# 自指消解: CID 常量内嵌于被哈希的文件中, 直接 pin 会导致「写入 CID→内容变→CID 变」永不收敛。
# 故 pin 前把这两行 CID 值归一为固定哨兵(以 __ 开头, 命中运行时 guard cid.indexOf("__")!==0 即视为未 pin),
# 使被 pin 的内容与 CID 常量无关 → CID 仅随真实内容变化而变, 幂等收敛。仓库实际文件仍写真实 CID(供 APK 兜底用)。
SENTINEL = "__IPFS_CID__"
_NORM = [
    (re.compile(r'(var P2P_WEB_IPFS_CID = ")[^"]*(")'), r'\1' + SENTINEL + r'\2'),
    (re.compile(r'(var P2P_CLIENT_IPFS_CID=")[^"]*(")'), r'\1' + SENTINEL + r'\2'),
]

def _read_normalized(full):
    data = open(full, "rb").read()
    if os.path.basename(full) in ("tunnel.html", "console.html"):
        txt = data.decode("utf-8")
        for pat, repl in _NORM:
            txt = pat.sub(repl, txt)
        data = txt.encode("utf-8")
    return data

files = []
for root, _, fns in os.walk(ENGINE):
    for fn in sorted(fns):
        full = os.path.join(root, fn)
        rel = os.path.relpath(full, ENGINE).replace(os.sep, "/")
        files.append((full, "engine/" + rel))
files.sort(key=lambda x: x[1])

boundary = "----dao" + uuid.uuid4().hex
CRLF = b"\r\n"
body = bytearray()
for full, name in files:
    body += b"--" + boundary.encode() + CRLF
    body += ('Content-Disposition: form-data; name="file"; filename="%s"' % name).encode() + CRLF
    body += b"Content-Type: application/octet-stream" + CRLF + CRLF
    body += _read_normalized(full) + CRLF
for field, val in [("pinataOptions", json.dumps({"cidVersion": 1})),
                   ("pinataMetadata", json.dumps({"name": "dao-console-engine"}))]:
    body += b"--" + boundary.encode() + CRLF
    body += ('Content-Disposition: form-data; name="%s"' % field).encode() + CRLF + CRLF
    body += val.encode() + CRLF
body += b"--" + boundary.encode() + b"--" + CRLF

req = urllib.request.Request(
    "https://api.pinata.cloud/pinning/pinFileToIPFS",
    data=bytes(body), method="POST",
    headers={"Authorization": "Bearer " + JWT,
             "Content-Type": "multipart/form-data; boundary=" + boundary})
try:
    r = urllib.request.urlopen(req, timeout=180, context=ctx)
    out = r.read().decode()
    print(out)
except urllib.error.HTTPError as e:
    print("HTTPError", e.code, e.read().decode(), file=sys.stderr)
    sys.exit(1)
