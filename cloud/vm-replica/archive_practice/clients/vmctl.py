"""vmctl.py - token-aware client for the host daemon (localhost:9000)."""
import sys, os, json, urllib.request, base64

CFG = json.load(open(r'C:\ProgramData\dao_vm\config.json', encoding='utf-8'))
TOKEN = CFG['token']
HOST = f"http://127.0.0.1:{CFG['host_port']}"

def call(action, timeout=120, **kw):
    body = dict(action=action, **kw)
    req = urllib.request.Request(HOST + '/', data=json.dumps(body).encode(),
        method='POST', headers={'Content-Type': 'application/json',
                                'Authorization': f'Bearer {TOKEN}'})
    try:
        return json.loads(urllib.request.urlopen(req, timeout=timeout).read().decode())
    except urllib.error.HTTPError as e:
        return json.loads(e.read().decode())

def get(path):
    req = urllib.request.Request(HOST + path, headers={'Authorization': f'Bearer {TOKEN}'})
    return json.loads(urllib.request.urlopen(req, timeout=10).read().decode())

if __name__ == '__main__':
    action = sys.argv[1] if len(sys.argv) > 1 else 'vm.list'
    kw = {}
    for a in sys.argv[2:]:
        k, _, v = a.partition('=')
        kw[k] = v
    print(json.dumps(call(action, **kw), ensure_ascii=False, indent=2))
