// ManyLives paid tools: call any of the pay-per-call services at https://manylives.me/paid from your own wallet.
// Payment: HTTP 402, USDC on Base, signed per call (EIP-3009). Without a key, calls use the free trial (3 a day).
import { privateKeyToAccount } from "viem/accounts";

const BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const MANYLIVES_TREASURY = "0xd161874249321f8ae3000c19ddd070e46682f1b3";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
const unb64 = (s) => JSON.parse(Buffer.from(s, "base64").toString());

/**
 * @param {object} [opts]
 * @param {string} [opts.privateKey]   0x key of a Base wallet holding a little USDC (omit to use free trial calls only)
 * @param {number} [opts.maxUsdPerCall=0.05]  refuse any call priced above this
 * @param {number} [opts.maxUsdPerDay=1]      stop paying after this much in one day (per process)
 * @param {string} [opts.baseUrl="https://manylives.me"]
 * @param {string} [opts.payTo]        expected receiver (defaults to the ManyLives treasury; protects against a spoofed server)
 */
export function createClient(opts = {}) {
  const baseUrl = (opts.baseUrl ?? "https://manylives.me").replace(/\/$/, "");
  const maxPerCall = opts.maxUsdPerCall ?? 0.05, maxPerDay = opts.maxUsdPerDay ?? 1;
  const payTo = (opts.payTo ?? MANYLIVES_TREASURY).toLowerCase();
  const account = opts.privateKey ? privateKeyToAccount(opts.privateKey) : null;
  let spentDay = "", spent = 0;
  let cache = null;

  async function catalogue() {
    if (!cache) {
      const r = await fetch(`${baseUrl}/paid`);
      if (!r.ok) throw new Error(`catalogue unavailable (${r.status})`);
      cache = (await r.json()).services;
    }
    return cache;
  }

  function request(svc, input) {
    const url = new URL(svc.url);
    const init = { method: svc.method, headers: {} };
    if (svc.method === "GET") for (const [k, v] of Object.entries(input ?? {})) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    else { init.headers["content-type"] = "application/json"; init.body = JSON.stringify(input ?? {}); }
    return { url, init };
  }

  async function pay(required) {
    const a = (required.accepts ?? []).find((x) => x.scheme === "exact" && x.network === "eip155:8453" && String(x.asset).toLowerCase() === BASE_USDC);
    if (!a) throw new Error("no supported payment option (USDC on Base) offered");
    if (String(a.payTo).toLowerCase() !== payTo) throw new Error(`refusing to pay an unexpected receiver ${a.payTo}`);
    const usd = Number(a.amount) / 1e6;
    if (usd > maxPerCall) throw new Error(`price US$${usd} is above maxUsdPerCall (${maxPerCall})`);
    const day = new Date().toISOString().slice(0, 10);
    if (day !== spentDay) { spentDay = day; spent = 0; }
    if (spent + usd > maxPerDay) throw new Error(`daily spend cap reached (US$${maxPerDay})`);
    const now = Math.floor(Date.now() / 1000);
    const nonce = `0x${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex")}`;
    const authorization = { from: account.address, to: a.payTo, value: a.amount, validAfter: String(now - 600), validBefore: String(now + (a.maxTimeoutSeconds ?? 120)), nonce };
    const signature = await account.signTypedData({
      domain: { name: a.extra?.name ?? "USD Coin", version: a.extra?.version ?? "2", chainId: 8453, verifyingContract: a.asset },
      types: { TransferWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] },
      primaryType: "TransferWithAuthorization",
      message: { ...authorization, value: BigInt(authorization.value), validAfter: BigInt(authorization.validAfter), validBefore: BigInt(authorization.validBefore) },
    });
    return { header: b64({ x402Version: 2, resource: required.resource, accepted: a, payload: { signature, authorization }, extensions: required.extensions }), usd };
  }

  /** Call one service by name ("token/verdict") or path ("/paid/token/verdict"). Returns the parsed JSON result. */
  async function call(name, input = {}) {
    const path = name.startsWith("/paid/") ? name : `/paid/${name.replace(/^\/+/, "")}`;
    const svc = (await catalogue()).find((s) => new URL(s.url).pathname === path);
    if (!svc) throw new Error(`unknown service ${name}`);
    const { url, init } = request(svc, input);
    if (!account) url.searchParams.set("trial", "1");
    const first = await fetch(url, init);
    if (first.status !== 402) return parse(first);
    if (!account) throw new Error(`${(await first.json().catch(() => ({}))).error ?? "payment required"} Set a wallet key to pay per call.`);
    const required = unb64(first.headers.get("payment-required"));
    const { header, usd } = await pay(required);
    const res = await fetch(url, { ...init, headers: { ...init.headers, "PAYMENT-SIGNATURE": header } });
    if (res.ok && res.headers.get("payment-response")) spent += usd;
    return parse(res);
  }

  async function parse(res) {
    const j = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    if (!res.ok) throw new Error(j.error ? `${j.error}${j.charged === false ? " (not charged)" : ""}` : `HTTP ${res.status}`);
    return j;
  }

  /** Plain tool definitions: { name, description, parameters (JSON Schema), execute(input) } — one per service. */
  async function tools({ only } = {}) {
    return (await catalogue()).filter((s) => !s.url.endsWith("/paid/test")).map((s) => {
      const path = new URL(s.url).pathname;
      const fields = s.input?.queryParams ?? s.input?.body ?? {};
      const properties = Object.fromEntries(Object.entries(fields).map(([k, d]) => [k, { type: "string", description: String(d) }]));
      const required = Object.entries(fields).filter(([, d]) => /\(required\)/i.test(String(d))).map(([k]) => k);
      return {
        name: path.slice(6).replace(/[^a-z0-9]+/gi, "_"), path, price_usd: s.price_usd,
        description: `${s.description} (US$${s.price_usd} per call)`,
        parameters: { type: "object", properties, required, additionalProperties: false },
        execute: (input) => call(path, input),
      };
    }).filter((t) => !only || only.includes(t.name) || only.includes(t.path.slice(6)));
  }

  return { call, tools, catalogue, address: account?.address ?? null };
}
