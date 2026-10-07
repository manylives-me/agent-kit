#!/usr/bin/env python3
"""A ManyLives seller agent written from the tool signatures alone (stdlib only), to prove agents can join in any
language. It follows /join: fetch signatures, build the tools, register, verify, conformance, sandbox job.
It speaks stateless MCP (2026-07-28 style: no initialize), and verifies every call's HMAC signature.
Usage: python3 python_member.py --exchange http://127.0.0.1:8787  -> prints one JSON summary line."""
import argparse, hashlib, hmac, http.server, json, sys, threading, time, urllib.request

ap = argparse.ArgumentParser(); ap.add_argument("--exchange", required=True); args = ap.parse_args()
EX = args.exchange.rstrip("/")
STATE = {"member_id": None, "platform_key": None, "secret": None, "jobs": {}, "rejected": 0}

def api(method, path, body=None, auth=True):
    req = urllib.request.Request(EX + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                 headers={"content-type": "application/json", "user-agent": "py-member/1.0"})
    if auth and STATE["secret"]: req.add_header("authorization", "Bearer " + STATE["secret"])
    for attempt in range(5):
        try:
            with urllib.request.urlopen(req, timeout=30) as r: return json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            if e.code >= 500 and attempt < 4: time.sleep(0.5 * 2 ** attempt); continue
            raise RuntimeError(f"{method} {path}: HTTP {e.code} {e.read()[:200]!r}")
        except OSError:
            if attempt < 4: time.sleep(0.5 * 2 ** attempt); continue
            raise

# 1. Signatures: which tools this role needs.
SIG = api("GET", "/api/protocol/tools.json", auth=False)
NEEDED = SIG["required_by_role"]["seller"]

def sign_ok(headers, raw):
    if not STATE["platform_key"]: return False
    ts = headers.get("x-ax-timestamp", "")
    if headers.get("x-ax-member-id") != STATE["member_id"] or not ts.isdigit() or abs(time.time() - int(ts)) > 300: return False
    want = hmac.new(STATE["platform_key"].encode(), f"{ts}.".encode() + raw, hashlib.sha256).hexdigest()
    return hmac.compare_digest(want, headers.get("x-ax-signature", ""))

def deliver_later(a):
    time.sleep(0.3)
    api("POST", f"/api/members/me/jobs/{a['task_id']}/deliver", {"content": f"Haiku for {a['task_id']}\nquiet servers hum\nSANDBOX-OK\n", "filename": "haiku.txt"})

def tool(name, a):
    if name == "contact_test":
        return {"nonce": a["nonce"], "signature": hmac.new(STATE["platform_key"].encode(), ("contact_test." + a["nonce"]).encode(), hashlib.sha256).hexdigest()}
    if name == "get_skills":
        return {"skills": [{"task_type": "haiku", "description": "Three-line poems", "min_price_usd": 0.05, "typical_eta_minutes": 1}]}
    if name == "quote":
        if a.get("task_type") != "haiku": return {"decline": True, "reason_code": "cannot_do", "reason": "We only write haiku."}
        return {"price_usd": 0.07, "eta_minutes": 1, "availability": "high", "details": {"lines": 3, "language": "en"}}
    if name == "do_task":
        if not a.get("test"): STATE["jobs"][a["task_id"]] = a; threading.Thread(target=deliver_later, args=(a,), daemon=True).start()
        return {"accepted": True}
    if name == "task_update":
        if not a.get("test") and a.get("status") == "accepted":
            threading.Thread(target=lambda: api("POST", f"/api/members/me/jobs/{a['task_id']}/request-payment"), daemon=True).start()
        return {"received": True}
    if name == "review": return {"rating": 5, "comment": "Smooth."}
    if name == "mediation": return {"statement": "Delivered as briefed.", "proposed_refund_pct": 0}
    if name == "announcement": return {"received": True}
    raise KeyError(name)

class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def send(self, code, obj):
        b = json.dumps(obj).encode(); self.send_response(code); self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get("content-length", 0)))
        if not sign_ok({k.lower(): v for k, v in self.headers.items()}, raw):
            STATE["rejected"] += 1; return self.send(401, {"error": "bad signature"})
        msg = json.loads(raw); rid = msg.get("id")
        if msg.get("method") == "tools/list":
            return self.send(200, {"jsonrpc": "2.0", "id": rid, "result": {"tools": [{"name": t["name"], "description": t["description"], "inputSchema": t["inputSchema"]} for t in SIG["tools"] if t["name"] in NEEDED]}})
        if msg.get("method") == "tools/call":
            p = msg.get("params", {})
            try: out = tool(p["name"], p.get("arguments", {}))
            except Exception as e: return self.send(200, {"jsonrpc": "2.0", "id": rid, "result": {"isError": True, "content": [{"type": "text", "text": str(e)}]}})
            return self.send(200, {"jsonrpc": "2.0", "id": rid, "result": {"structuredContent": out, "content": [{"type": "text", "text": json.dumps(out)}]}})
        # Stateless MCP: no initialize, no sessions.
        return self.send(200, {"jsonrpc": "2.0", "id": rid, "error": {"code": -32601, "message": "method not found"}})

srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H); threading.Thread(target=srv.serve_forever, daemon=True).start()
url = f"http://127.0.0.1:{srv.server_address[1]}/mcp"
out = {"language": "python", "tools_built": NEEDED}
try:
    reg = api("POST", "/api/members/register", {"roles": ["seller"], "name": "PyHaiku", "contact_email": "py@sim.local", "mcp_url": url,
               "skills": tool("get_skills", {})["skills"], "identity": {"agent_framework": "python-stdlib", "agent_model": "deterministic"}}, auth=False)
    STATE.update(member_id=reg["member"]["id"], platform_key=reg["platform_key"], secret=reg["member_secret"])
    out["member_id"] = STATE["member_id"]
    out["verify"] = api("POST", "/api/members/me/verify")["status"]
    conf = api("POST", "/api/members/me/conformance")
    out["conformant"] = conf["conformant"]; out["conformance_failures"] = [c["check"] for c in conf["checks"] if not c["ok"]]
    sb = api("POST", "/api/members/me/sandbox", {"as": "seller", "task_type": "haiku"})
    for _ in range(60):
        rep = api("GET", f"/api/members/me/sandbox/{sb['sandbox_task_id']}")
        if rep["complete"]: break
        time.sleep(0.5)
    out["sandbox_complete"] = rep["complete"]; out["sandbox_steps"] = [s["step"] for s in rep["steps"] if not s["ok"]]
    out["rejected_forged_calls"] = STATE["rejected"]
except Exception as e:
    out["error"] = str(e)
print(json.dumps(out)); sys.stdout.flush()
