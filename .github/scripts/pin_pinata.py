#!/usr/bin/env python3
"""把 rt-flow engine 静态壳目录 pin 到 Pinata, 取确定性 CIDv1 内容寻址。
用于 .github/workflows/pin-console-host.yml 发版自动重 pin。
读环境变量 PINATA_JWT。成功时 stdout 打印含 IpfsHash 的 JSON(供 workflow 解析 CID)。
"""
import os, json, urllib.request, ssl, uuid, sys

JWT = os.environ.get("PINATA_JWT", "").strip()
if not JWT:
    print("PINATA_JWT missing", file=sys.stderr); sys.exit(2)

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ENGINE = os.path.join(REPO_ROOT, "addons", "rt-flow-app", "app", "src", "main", "assets", "engine")
ctx = ssl.create_default_context()

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
    body += open(full, "rb").read() + CRLF
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
