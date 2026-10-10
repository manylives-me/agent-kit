"""ManyLives pay-per-call tools for Python agents (LangGraph / LangChain, CrewAI, or plain Python).

Verifiable trading-strategy track records, a one-call market brief, position sizing, contract and token security
checks, web and browser tools and 170+ other services at https://api.manylives.me/paid. Each call is paid from your
own wallet in USDC on the Base network over HTTP 402 (EIP-3009), with per-call and per-day caps; payment only ever
goes to the ManyLives treasury. Without a key, calls use the free trial (3 a day).
"""
from __future__ import annotations

import base64
import json
import os
import secrets
import time
from typing import Any, Callable

import requests

__all__ = ["ManyLives", "langchain_tools", "crewai_tools"]
__version__ = "0.1.0"

BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"
MANYLIVES_TREASURY = "0xd161874249321f8ae3000c19ddd070e46682f1b3"
NOT_ADVICE = "General information only, not financial advice."


def _b64(o: Any) -> str:
    return base64.b64encode(json.dumps(o).encode()).decode()


class ManyLives:
    """Client for ManyLives paid tools. private_key: a small dedicated Base wallet holding a little USDC (optional)."""

    def __init__(self, private_key: str | None = None, max_usd_per_call: float = 0.05, max_usd_per_day: float = 1.0,
                 base_url: str = "https://api.manylives.me", timeout: float = 60):
        self.base_url = base_url.rstrip("/")
        self.max_per_call, self.max_per_day, self.timeout = max_usd_per_call, max_usd_per_day, timeout
        self._spent_day, self._spent = "", 0.0
        self._catalogue: list[dict] | None = None
        key = private_key or os.environ.get("MANYLIVES_PRIVATE_KEY")
        if key:
            from eth_account import Account
            self.account = Account.from_key(key)
        else:
            self.account = None

    # -- catalogue
    def catalogue(self) -> list[dict]:
        if self._catalogue is None:
            r = requests.get(f"{self.base_url}/paid", timeout=self.timeout)
            r.raise_for_status()
            self._catalogue = r.json()["services"]
        return self._catalogue

    def _service(self, name: str) -> dict:
        path = name if name.startswith("/paid/") else f"/paid/{name.lstrip('/')}"
        for s in self.catalogue():
            if s["url"].endswith(path):
                return s
        raise ValueError(f"unknown service {name}")

    # -- payment
    def _pay(self, required: dict) -> tuple[str, float]:
        a = next((x for x in required.get("accepts", []) if x.get("scheme") == "exact" and x.get("network") == "eip155:8453"
                  and str(x.get("asset", "")).lower() == BASE_USDC), None)
        if not a:
            raise RuntimeError("no supported payment option (USDC on Base) offered")
        if str(a["payTo"]).lower() != MANYLIVES_TREASURY:
            raise RuntimeError(f"refusing to pay an unexpected receiver {a['payTo']}")
        usd = int(a["amount"]) / 1e6
        if usd > self.max_per_call:
            raise RuntimeError(f"price US${usd} is above max_usd_per_call ({self.max_per_call})")
        day = time.strftime("%Y-%m-%d", time.gmtime())
        if day != self._spent_day:
            self._spent_day, self._spent = day, 0.0
        if self._spent + usd > self.max_per_day:
            raise RuntimeError(f"daily spend cap reached (US${self.max_per_day})")
        now = int(time.time())
        auth = {"from": self.account.address, "to": a["payTo"], "value": str(a["amount"]), "validAfter": str(now - 600),
                "validBefore": str(now + int(a.get("maxTimeoutSeconds", 120))), "nonce": "0x" + secrets.token_hex(32)}
        typed = {
            "types": {
                "EIP712Domain": [{"name": "name", "type": "string"}, {"name": "version", "type": "string"},
                                 {"name": "chainId", "type": "uint256"}, {"name": "verifyingContract", "type": "address"}],
                "TransferWithAuthorization": [{"name": "from", "type": "address"}, {"name": "to", "type": "address"},
                                              {"name": "value", "type": "uint256"}, {"name": "validAfter", "type": "uint256"},
                                              {"name": "validBefore", "type": "uint256"}, {"name": "nonce", "type": "bytes32"}],
            },
            "primaryType": "TransferWithAuthorization",
            "domain": {"name": (a.get("extra") or {}).get("name", "USD Coin"), "version": (a.get("extra") or {}).get("version", "2"),
                       "chainId": 8453, "verifyingContract": a["asset"]},
            "message": {**auth, "value": int(auth["value"]), "validAfter": int(auth["validAfter"]), "validBefore": int(auth["validBefore"])},
        }
        sig = self.account.sign_typed_data(full_message=typed).signature.hex()
        header = _b64({"x402Version": 2, "resource": required.get("resource"), "accepted": a,
                       "payload": {"signature": sig if sig.startswith("0x") else "0x" + sig, "authorization": auth},
                       "extensions": required.get("extensions")})
        return header, usd

    def call(self, name: str, **inputs: Any) -> dict:
        """Call a service by name ('market/brief') or path ('/paid/market/brief'); returns the parsed JSON result."""
        s = self._service(name)
        method = s["method"]
        params = {k: str(v) for k, v in inputs.items() if v is not None} if method == "GET" else None
        body = None if method == "GET" else {k: v for k, v in inputs.items() if v is not None}
        if self.account is None:
            params = {**(params or {}), "trial": "1"}
        r = requests.request(method, s["url"], params=params, json=body, timeout=self.timeout)
        if r.status_code == 402 and self.account is not None:
            required = json.loads(base64.b64decode(r.headers["payment-required"]))
            header, usd = self._pay(required)
            r = requests.request(method, s["url"], params=params, json=body, timeout=self.timeout, headers={"PAYMENT-SIGNATURE": header})
            if r.ok and r.headers.get("payment-response"):
                self._spent += usd
        data = r.json() if r.headers.get("content-type", "").startswith("application/json") else {"error": r.text[:300]}
        if not r.ok:
            raise RuntimeError(f"{data.get('error', f'HTTP {r.status_code}')}{' (not charged)' if data.get('charged') is False else ''}")
        return data

    # -- tool definitions (framework-neutral)
    def tool_specs(self, only: list[str] | None = None) -> list[dict]:
        out = []
        for s in self.catalogue():
            path = s["url"].split("/paid/", 1)[1]
            if path == "test" or (only and path not in only):
                continue
            fields = (s.get("input") or {}).get("queryParams") or (s.get("input") or {}).get("body") or {}
            out.append({"name": "manylives_" + "".join(ch if ch.isalnum() else "_" for ch in path), "path": path, "price_usd": s["price_usd"],
                        "description": f"{s['description']} (US${s['price_usd']} per call)", "fields": fields})
        return out


TRADING_TOOLS = ["trackrecord/top", "trackrecord/record", "trackrecord/verify", "market/brief", "trading/risk", "token/verdict", "contract/audit", "crypto/price"]


def langchain_tools(client: ManyLives | None = None, only: list[str] | None = None):
    """LangChain / LangGraph StructuredTools (default: the trading tools; pass only=None-like list for others)."""
    from langchain_core.tools import StructuredTool
    from pydantic import Field, create_model
    client = client or ManyLives()
    tools = []
    for spec in client.tool_specs(only or TRADING_TOOLS):
        model = create_model(spec["name"] + "_input", **{k: (str | None, Field(default=None, description=str(d)[:300])) for k, d in spec["fields"].items()})
        fn: Callable[..., str] = (lambda p: (lambda **kw: json.dumps(client.call(p, **kw))))(spec["path"])
        tools.append(StructuredTool.from_function(func=fn, name=spec["name"][:64], description=spec["description"][:1000], args_schema=model))
    return tools


def crewai_tools(client: ManyLives | None = None, only: list[str] | None = None):
    """CrewAI tools (BaseTool subclasses) for the same services."""
    from crewai.tools import BaseTool
    client = client or ManyLives()
    tools = []
    for spec in client.tool_specs(only or TRADING_TOOLS):
        path = spec["path"]

        class _T(BaseTool):
            name: str = spec["name"][:64]
            description: str = spec["description"][:1000] + " Input: a JSON object with these fields: " + ", ".join(spec["fields"].keys())

            def _run(self, **kwargs: Any) -> str:  # noqa: D401
                return json.dumps(client.call(path, **kwargs))
        tools.append(_T())
    return tools
