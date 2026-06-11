# -*- coding: utf-8 -*-
import sys, os, io, json
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dao_sdk as d

# try a range of likely admin endpoints to inspect/cancel the DESKTOP-MASTER queue
paths_get = [
    "/", "/api", "/api/status", "/api/agents/DESKTOP-MASTER",
    "/api/agents/DESKTOP-MASTER/commands", "/api/agents/DESKTOP-MASTER/queue",
    "/api/commands?agent_id=DESKTOP-MASTER",
]
for p in paths_get:
    r = d.api("GET", p, timeout=10)
    s = json.dumps(r, ensure_ascii=False)
    print("GET", p, "->", s[:300])

# try cancel/clear endpoints (POST)
paths_post = [
    ("/api/agents/DESKTOP-MASTER/cancel", {}),
    ("/api/agents/DESKTOP-MASTER/clear", {}),
    ("/api/cancel", {"agent_id": "DESKTOP-MASTER"}),
    ("/api/agents/DESKTOP-MASTER/restart", {}),
]
for p, body in paths_post:
    r = d.api("POST", p, body, timeout=10)
    s = json.dumps(r, ensure_ascii=False)
    print("POST", p, "->", s[:300])
