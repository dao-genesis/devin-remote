import urllib.request, json, ssl, time, os, base64

# === proxy immunity + SSL skip (trycloudflare self-signed) ===
for k in ('HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'):
    os.environ.pop(k, None)
os.environ['NO_PROXY'] = '*'

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

opener = urllib.request.build_opener(
    urllib.request.ProxyHandler({}),
    urllib.request.HTTPSHandler(context=ctx),
)
urllib.request.install_opener(opener)

URL   = os.environ.get("DAO_URL", "https://qualify-wrap-ministries-liable.trycloudflare.com")
TOKEN = os.environ.get("DAO_TOKEN", "dao-ps-agent-2026")

def api(method, path, body=None, timeout=30):
    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(f"{URL}{path}", data=data,
        headers={"Authorization": f"Bearer {TOKEN}",
                 "Content-Type": "application/json"},
        method=method)
    try:
        return json.loads(urllib.request.urlopen(req, timeout=timeout).read())
    except urllib.error.HTTPError as e:
        return json.loads(e.read()) if e.fp else {"error": str(e)}
    except Exception as e:
        return {"error": str(e)}

def health():
    return api("GET", "/api/health")

def agents():
    return api("GET", "/api/agents")

def dao(cmd, agent="ZHOUMAC", timeout=30, retries=3):
    for i in range(retries):
        r = api("POST", "/api/exec-sync", {
            "agent_id": agent, "cmd": cmd, "timeout": timeout
        }, timeout=timeout + 15)
        if r.get("status") == "completed":
            return r["result"]["stdout"]
        if "not found" in str(r.get("error", "")):
            time.sleep(5)
    return f"[dao] unreachable: {agent} :: {r}"

def dao_raw(cmd, agent="ZHOUMAC", timeout=30):
    r = api("POST", "/api/exec-sync", {
        "agent_id": agent, "cmd": cmd, "timeout": timeout
    }, timeout=timeout + 15)
    return r.get("result", {}) if r.get("status") == "completed" else r

if __name__ == "__main__":
    import sys
    print("HEALTH:", json.dumps(health(), ensure_ascii=False))
    print("AGENTS:", json.dumps(agents(), ensure_ascii=False))
