#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
dao-e2e · RPC 载荷端到端加密 (Python 参考实现)

与设备端 (addons/rt-flow-app/.../RelayService.java 的 E2E 内部类) 及
tools/dao-e2e/dao-e2e.js 逐字节兼容:
  · 密钥派生: PBKDF2-HMAC-SHA256(passphrase, salt, 100000, 32B)
  · 对称加密: AES-256-GCM (128-bit tag, 附于密文尾, 与 Java/WebCrypto 一致)
  · 信封(base64, NO_WRAP): [ver=1 (1B)] [salt (16B)] [iv (12B)] [ciphertext+tag]

用途: 授权驱动方 (A群) 经中继驱动设备时, 把 RPC 请求 body 封成
  {"__e2e__": 1, "c": seal(passphrase, json.dumps(real_body))}
中继(含任何共享 Worker)只见密文; 设备用同一 passphrase 解密、处理、再加密响应,
响应 body 形如 {"__e2e__": 1, "c": "<密文>"}, 驱动方用同 key open 还原。

依赖: cryptography  (pip install cryptography)
"""
import os
import base64
import json
import urllib.request

from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

PBKDF2_ITERS = 100000
VERSION = 1


def _derive(passphrase: str, salt: bytes) -> bytes:
    kdf = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt,
                     iterations=PBKDF2_ITERS)
    return kdf.derive(passphrase.encode("utf-8"))


def seal(passphrase: str, plaintext: str) -> str:
    """明文 → base64 信封 [ver][salt16][iv12][ct+tag]。"""
    salt = os.urandom(16)
    iv = os.urandom(12)
    key = _derive(passphrase, salt)
    ct = AESGCM(key).encrypt(iv, plaintext.encode("utf-8"), None)
    return base64.b64encode(bytes([VERSION]) + salt + iv + ct).decode("ascii")


def open(passphrase: str, envelope_b64: str) -> str:
    """base64 信封 → 明文。"""
    raw = base64.b64decode(envelope_b64)
    if len(raw) < 30 or raw[0] != VERSION:
        raise ValueError("bad envelope")
    salt, iv, ct = raw[1:17], raw[17:29], raw[29:]
    key = _derive(passphrase, salt)
    return AESGCM(key).decrypt(iv, ct, None).decode("utf-8")


def rpc(endpoint: str, token: str, e2e_key: str, cmd: str, **args) -> dict:
    """经中继对设备发一条端到端加密的 RPC, 返回已解密的响应 body。

    endpoint 例: https://<relay>/relay/rtflow-xxxx
    token:    当前设备 token (穿透面板可复制; 中继仅用它定址, 看不到载荷明文)
    e2e_key:  端到端加密口令 (取数指引 MD「板块六」给出)
    """
    real_body = dict(args)
    real_body["cmd"] = cmd
    outer = {"path": "/api/rpc", "method": "POST",
             "body": {"__e2e__": 1, "c": seal(e2e_key, json.dumps(real_body))}}
    req = urllib.request.Request(
        endpoint, data=json.dumps(outer).encode("utf-8"),
        headers={"Authorization": "Bearer " + token,
                 "Content-Type": "application/json",
                 # workers.dev 边缘对 Python-urllib UA 会 403, 用常规 UA 绕过
                 "User-Agent": "Mozilla/5.0 (dao-e2e)"}, method="POST")
    with urllib.request.urlopen(req, timeout=65) as r:
        resp = json.loads(r.read().decode("utf-8"))
    if isinstance(resp, dict) and resp.get("__e2e__"):
        return json.loads(open(e2e_key, resp["c"]))
    return resp  # 明文回退 (设备未启用 e2e 或旧版)


if __name__ == "__main__":
    # 自检: seal→open 往返
    k = "test-passphrase-0123456789"
    msg = json.dumps({"cmd": "getState", "note": "账号密码不应明文过中继"})
    env = seal(k, msg)
    assert open(k, env) == msg, "round-trip failed"
    print("self-test ok · envelope=", env[:48], "...")
