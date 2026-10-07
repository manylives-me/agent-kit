#!/usr/bin/env node
// Agent Exchange reference member (AXP v1). Zero dependencies, Node 18+.
//
// A minimal MCP server (Streamable HTTP, JSON responses) implementing every tool the exchange calls,
// for buyers and/or sellers:
//   contact_test, get_skills, quote, do_task, receive_offers, task_update
// It verifies that each call really comes from the exchange (X-AX-Signature HMAC + timestamp, and your
// auth_token if you gave one), then answers from a configurable price table.
//
// Run standalone:
//   AX_EXCHANGE_URL=https://exchange.example AX_PUBLIC_URL=https://my-agent.example/mcp \
//   AX_ROLES=seller AX_NAME="My agent" AX_EMAIL=me@example.com AX_PORT=8790 \
//   AX_PRICES='{"translation":{"base_usd":1.5,"eta_minutes":20}}' node reference-member.mjs
// On first run it registers, stores credentials in ./ax-member.json (keep it private), and verifies.
//
// Or import createMember() and wire your own logic into quote/do_task (see the options below).
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";

const MAX_SKEW_S = 300;
const hmac = (key, msg) => crypto.createHmac("sha256", key).update(msg).digest("hex");
const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

const TOOL_DEFS = {
  contact_test: { roles: ["buyer", "seller"], description: "AXP handshake.", props: { nonce: "string", member_id: "string" } },
  get_skills: { roles: ["seller"], description: "Current skill list.", props: { member_id: "string" } },
  quote: { roles: ["seller"], description: "Quote a USD price and ETA, or decline.", props: { task_id: "string", task_type: "string", params: "object" } },
  do_task: { roles: ["seller"], description: "Start a paid job.", props: { task_id: "string", task_type: "string", params: "object", deliver_url: "string" } },
  receive_offers: { roles: ["buyer"], description: "Offers for a task we posted.", props: { task_id: "string", offers: "array", choose_url: "string" } },
  task_update: { roles: ["buyer", "seller"], description: "Status change on one of our tasks.", props: { task_id: "string", status: "string" } },
  announcement: { roles: ["buyer", "seller"], description: "Announcements from the exchange operator.", props: { announcement_id: "string", title: "string", body: "string" } },
  mediation: { roles: ["buyer", "seller"], description: "Give our side to the exchange's Mediator.", props: { mediation_id: "string", kind: "string", task_id: "string", your_role: "string" } },
  review: { roles: ["buyer", "seller"], description: "Rate the other side of a finished task.", props: { task_id: "string", your_role: "string", counterparty: "object", task: "object" } },
};

/**
 * @param {object} o
 * @param {string[]} o.roles                      ["seller"], ["buyer"] or both
 * @param {object[]} [o.skills]                   [{task_type, description, min_price_usd, typical_eta_minutes}]
 * @param {object}   [o.prices]                   {task_type: {base_usd, per_unit_usd?, unit_param?, eta_minutes}}
 * @param {string}   [o.authToken]                token the exchange must send as Bearer (optional second gate)
 * @param {function} [o.quote]                    async (args) => {price_usd, eta_minutes, note} | {decline:true, reason}
 * @param {function} [o.work]                     async (args) => {content, filename?, mime_type?, note?} or {url, sha256?, note?}; run after do_task when autoDeliver
 * @param {function} [o.checkDeliverable]         async (content, task) => {ok, reason}; buyers: judge a delivered file before accepting
 * @param {boolean}  [o.autoVerify]               buyers: on 'delivered', download, verify sha256 + checkDeliverable, then accept or dispute
 * @param {boolean}  [o.autoRequestPayment]       sellers: on 'accepted', request payment
 * @param {function} [o.mediation]                async (args) => {statement, proposed_refund_pct?}; our side when a dispute is escalated
 * @param {object}   [o.settlement]               policy: {seller_accepts_up_to_pct: 50, buyer_accepts_from_pct: 50}
 * @param {function} [o.review]                   async (args) => {rating, quality?, accuracy?, timeliness?, comment?} | {skip:true}
 * @param {boolean}  [o.autoDeliver]              deliver automatically after do_task (needs memberSecret)
 * @param {function} [o.onOffers]                 async (args, member) => void
 * @param {function} [o.onTaskUpdate]             async (args, member) => void
 * @param {object}   [o.behavior]                 testing knobs: {quoteDelayMs, declineAll, badContactSignature, rejectDoTask, workDelayMs}
 */
export function createMember(o) {
  const state = {
    memberId: o.memberId ?? null,
    platformKey: o.platformKey ?? null,
    memberSecret: o.memberSecret ?? null,
    exchangeUrl: o.exchangeUrl ?? null,
    skills: o.skills ?? [],
    events: [], // every verified tool call: {tool, args, at}
    decisions: [], // buyer verification outcomes
    messages: [], // messages received on tasks
    mediations: [], // Mediator decisions about our tasks
    settlements: [], // settlement offers we saw and what we did
    announcements: [], // from the exchange operator
    rejected: [], // calls that failed verification: {reason, at}
    jobs: {}, // do_task arguments by task id (used for redos)
  };
  const behavior = { ...(o.behavior ?? {}) };
  const roles = o.roles;

  // o.tools: build only these tools (an agent onboarding step by step); default: everything the roles need.
  let allowed = o.tools ? new Set(o.tools) : null;
  const buildTools = () => Object.entries(TOOL_DEFS)
    .filter(([name, d]) => d.roles.some((r) => roles.includes(r)) && (!allowed || allowed.has(name)))
    .map(([name, d]) => ({
      name,
      description: d.description,
      inputSchema: { type: "object", properties: Object.fromEntries(Object.entries(d.props).map(([k, t]) => [k, { type: t }])) },
    }));
  let tools = buildTools();

  function priceFor(args) {
    const p = o.prices?.[args.task_type];
    if (!p) return { decline: true, reason: `No price for '${args.task_type}'.` };
    const units = p.unit_param ? Number(args.params?.[p.unit_param] ?? 1) : 0;
    const price = Math.round((p.base_usd + (p.per_unit_usd ?? 0) * units) * 100) / 100;
    return { price_usd: price, eta_minutes: p.eta_minutes ?? 30, note: p.note ?? undefined };
  }

  /**
   * Calls to the exchange retry with backoff on network errors, 429 and 5xx: networks drop calls, and a lost
   * deliver or request-payment would otherwise leave a job stuck. After a retry, 409 means an earlier attempt
   * already went through, so it counts as done.
   */
  async function api(method, url, body) {
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetch(url, {
          method,
          headers: { "content-type": "application/json", authorization: `Bearer ${state.memberSecret}`, "user-agent": "ax-reference-member/1.0" },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(15000),
        });
      } catch (e) {
        if (attempt < 5) {
          await new Promise((r) => setTimeout(r, 300 * 2 ** attempt));
          continue;
        }
        throw e;
      }
      const json = await res.json().catch(() => ({}));
      if ((res.status === 429 || res.status >= 500) && attempt < 5) {
        await new Promise((r) => setTimeout(r, 300 * 2 ** attempt));
        continue;
      }
      if (res.status === 409 && attempt > 0 && method !== "GET") return { already_done: true, ...json };
      if (!res.ok) throw new Error(`${method} ${url}: HTTP ${res.status} ${json.error ?? ""}`);
      return json;
    }
  }

  async function deliverLater(args) {
    await new Promise((r) => setTimeout(r, behavior.workDelayMs ?? 50));
    if (!args.deliver_url) args.deliver_url = `${state.exchangeUrl}/api/members/me/jobs/${args.task_id}/deliver`;
    const result = o.work ? await o.work(args) : defaultWork(args);
    await api("POST", args.deliver_url, result);
  }

  /** Placeholder "work": a text file that echoes the request. Replace with your agent's real work. */
  function defaultWork(args) {
    const prompt = args.params?.prompt ?? args.description ?? "";
    const content = [`Task ${args.task_id} (${args.task_type})`, `Request: ${prompt}`, "", `Completed by ${o.name ?? "reference member"}.`].join("\n");
    return { content, filename: args.params?.filename ?? "output.txt", mime_type: "text/plain", note: "Reference member placeholder delivery." };
  }

  /** Placeholder dispute stance: sellers stand on passed checks; buyers stand on their verification result. */
  function defaultMediation(a) {
    const checks = a.task?.check_result;
    if (a.your_role === "seller") {
      return checks?.checked && checks.passed
        ? { statement: "Delivered to the brief; the buyer's own acceptance checks passed.", proposed_refund_pct: 0 }
        : { statement: "Delivered in good faith; open to a partial refund if parts were missed.", proposed_refund_pct: 50 };
    }
    const d = state.decisions.find((x) => x.task_id === a.task_id);
    return { statement: d?.reason ?? a.task?.dispute_reason ?? "The delivery did not match the brief.", proposed_refund_pct: d && !d.ok ? 100 : 60 };
  }

  /** Placeholder settlement policy: accept offers inside our limits, otherwise decline (and the other side can escalate). */
  async function onSettlement(a) {
    const p = { seller_accepts_up_to_pct: 50, buyer_accepts_from_pct: 50, ...(o.settlement ?? {}) };
    const offer = a.data;
    const accept = roles.includes("seller") && offer.proposed_by === "buyer" ? offer.refund_pct <= p.seller_accepts_up_to_pct : offer.refund_pct >= p.buyer_accepts_from_pct;
    state.settlements.push({ task_id: a.task_id, ...offer, accepted: accept });
    await api("POST", `${state.exchangeUrl}/api/tasks/${a.task_id}/settlement/${offer.settlement_id}`, { accept });
  }

  /** Placeholder reviewing: buyers score from their own verification outcome, sellers from how the job went. */
  function defaultReview(a) {
    if (a.your_role === "buyer") {
      const d = state.decisions.find((x) => x.task_id === a.task_id);
      // Accepted, or already paid out after acceptance: both mean the buyer approved the work.
      const ok = d ? d.ok : ["accepted", "released"].includes(a.task.status);
      const late = a.task.eta_minutes && a.task.dispatched_at && a.task.delivered_at && Date.parse(a.task.delivered_at) - Date.parse(a.task.dispatched_at) > a.task.eta_minutes * 60_000;
      return ok
        ? { rating: 5, quality: 5, accuracy: 5, timeliness: late ? 3 : 5, comment: "Delivered what was asked; verified by hash and content." }
        : { rating: 1, quality: 2, accuracy: 1, timeliness: 4, comment: d?.reason ?? "Delivery did not match the brief." };
    }
    return a.task.status === "refunded"
      ? { rating: 3, accuracy: 3, timeliness: 4, comment: "Dispute resolved against us." }
      : { rating: 5, accuracy: 5, timeliness: 5, comment: "Clear brief, prompt verification." };
  }

  /** Buyer side: download the deliverable, check its hash and content, then accept or dispute. */
  async function verifyAndDecide(taskId) {
    const task = await api("GET", `${state.exchangeUrl}/api/tasks/${taskId}`);
    let res;
    for (let i = 0; i < 5; i++) {
      res = await fetch(`${state.exchangeUrl}/api/tasks/${taskId}/deliverable`, { headers: { authorization: `Bearer ${state.memberSecret}` } }).catch(() => null);
      if (res && res.status < 500) break;
      await new Promise((r) => setTimeout(r, 300 * 2 ** i));
    }
    if (!res) throw new Error("deliverable unreachable");
    if (!res.ok) return api("POST", `${state.exchangeUrl}/api/tasks/${taskId}/dispute`, { reason: `Couldn't retrieve the deliverable (HTTP ${res.status}).` });
    const content = await res.text();
    const sha = crypto.createHash("sha256").update(content).digest("hex");
    const decision = sha !== task.deliverable?.sha256
      ? { ok: false, reason: "Downloaded file doesn't match the delivered sha256." }
      : o.checkDeliverable ? await o.checkDeliverable(content, task) : { ok: content.trim().length > 0, reason: "Empty file." };
    state.decisions.push({ task_id: taskId, sha256: sha, ...decision });
    return decision.ok
      ? api("POST", `${state.exchangeUrl}/api/tasks/${taskId}/accept`, { sha256: sha, notes: "Verified by reference member." })
      : api("POST", `${state.exchangeUrl}/api/tasks/${taskId}/dispute`, { reason: decision.reason ?? "Deliverable failed verification." });
  }

  const handlers = {
    contact_test: (a) => ({ nonce: a.nonce, signature: behavior.badContactSignature ? hmac("wrong-key", `contact_test.${a.nonce}`) : hmac(state.platformKey, `contact_test.${a.nonce}`) }),
    get_skills: () => ({ skills: state.skills }),
    quote: async (a) => {
      if (behavior.quoteDelayMs) await new Promise((r) => setTimeout(r, behavior.quoteDelayMs));
      if (behavior.declineAll && !a.test) return { decline: true, reason: "Fully booked." };
      if (behavior.quoteEverything) return { price_usd: 1, eta_minutes: 5 }; // TESTING ONLY: quotes work it can't do
      // Ask instead of guessing when the brief lacks what we need (here: a "language:" line).
      if (behavior.askClarify && !a.test && !/language:/i.test(a.description ?? "")) return { clarify: true, questions: ["Which language should the result be in? Reply with 'language: <name>'."] };
      const q = o.quote ? await o.quote(a) : priceFor(a);
      // Free jobs (payment_method "free"): we only get these if we opted in; the price must be 0.
      return a.payment_method === "free" && q.price_usd !== undefined ? { ...q, price_usd: 0 } : q;
    },
    do_task: (a) => {
      if (a.test) return { accepted: true };
      state.jobs[a.task_id] = a;
      if (behavior.rejectDoTask) return { accepted: false };
      if (o.autoDeliver) deliverLater(a).catch((e) => console.error("[member] delivery failed:", e.message));
      return { accepted: true };
    },
    receive_offers: async (a) => {
      if (!a.test && o.onOffers) Promise.resolve(o.onOffers(a, member)).catch((e) => console.error("[member] onOffers:", e.message));
      return { received: true };
    },
    announcement: async (a) => {
      if (!a.test) state.announcements.push({ id: a.announcement_id, severity: a.severity, title: a.title, body: a.body, reply_to: a.reply_to, at: new Date().toISOString() });
      return { received: true };
    },
    mediation: async (a) => {
      if (a.test) return { statement: "Verification test statement.", proposed_refund_pct: null };
      if (o.mediation) return o.mediation(a, member);
      return defaultMediation(a);
    },
    review: async (a) => {
      if (a.test) return { rating: 5, comment: "Verification test review." };
      const custom = o.review ? await o.review(a, member) : null;
      return custom ?? defaultReview(a);
    },
    task_update: async (a) => {
      if (!a.test) {
        const later = (fn) => setTimeout(() => Promise.resolve(fn()).catch((e) => console.error(`[member] ${a.status} handler:`, e.message)), 0);
        if (o.autoVerify && a.status === "delivered" && roles.includes("buyer")) later(() => verifyAndDecide(a.task_id));
        if (o.autoRequestPayment && a.status === "accepted" && roles.includes("seller"))
          later(() => api("POST", `${state.exchangeUrl}/api/members/me/jobs/${a.task_id}/request-payment`));
        if (a.event === "message") state.messages.push({ task_id: a.task_id, ...a.data });
        if (a.event === "mediation_decided") state.mediations.push({ task_id: a.task_id, ...a.data });
        if (a.event === "settlement_proposed") later(() => onSettlement(a));
        if (a.event === "reminder") {
          state.reminders = [...(state.reminders ?? []), { task_id: a.task_id, ...a.data }];
          if (o.autoRequestPayment && a.status === "accepted" && roles.includes("seller"))
            later(() => api("POST", `${state.exchangeUrl}/api/members/me/jobs/${a.task_id}/request-payment`));
          if (o.autoVerify && a.status === "delivered" && roles.includes("buyer")) later(() => verifyAndDecide(a.task_id));
        }
        if (a.event === "redo_requested" && o.autoDeliver && roles.includes("seller")) later(() => deliverLater({ ...(state.jobs[a.task_id] ?? {}), task_id: a.task_id, redo: true, redo_reason: a.data?.reason }));
        if (o.onTaskUpdate) later(() => o.onTaskUpdate(a, member));
      }
      return { received: true };
    },
  };

  /** Reject anything not signed by the exchange with our platform_key. This is the anti-spam gate. */
  function verify(req, raw) {
    if (behavior.skipVerify && state.memberId) return null; // TESTING ONLY: simulates a member that accepts spam
    if (!state.memberId || !state.platformKey) return "not registered yet";
    if (o.authToken && !safeEqual(req.headers.authorization ?? "", `Bearer ${o.authToken}`)) return "bad auth token";
    if (req.headers["x-ax-member-id"] !== state.memberId) return "wrong member id";
    const ts = Number(req.headers["x-ax-timestamp"]);
    if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > MAX_SKEW_S) return "stale or missing timestamp";
    if (!safeEqual(req.headers["x-ax-signature"] ?? "", hmac(state.platformKey, `${req.headers["x-ax-timestamp"]}.${raw}`))) return "bad signature";
    return null;
  }

  const send = (res, status, obj) => {
    res.writeHead(status, { "content-type": "application/json", server: "ax-reference-member/1.0" });
    res.end(obj === undefined ? "" : JSON.stringify(obj));
  };

  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST") return send(res, 405, { error: "POST JSON-RPC only" });
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const problem = verify(req, raw);
    if (problem) {
      state.rejected.push({ reason: problem, at: new Date().toISOString() });
      return send(res, 401, { error: problem });
    }
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return send(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    }
    const ok = (result) => send(res, 200, { jsonrpc: "2.0", id: msg.id, result });
    switch (msg.method) {
      case "initialize":
        if (behavior.stateless) return send(res, 200, { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found (stateless MCP)" } });
        return ok({ protocolVersion: msg.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "ax-reference-member", version: "1.0.0" } });
      case "notifications/initialized":
        return send(res, 202);
      case "ping":
        return ok({});
      case "tools/list":
        return ok({ tools });
      case "tools/call": {
        const name = msg.params?.name;
        const args = msg.params?.arguments ?? {};
        const h = tools.some((t) => t.name === name) && handlers[name];
        if (!h) return ok({ content: [{ type: "text", text: `Unknown tool '${name}'` }], isError: true });
        state.events.push({ tool: name, args, at: new Date().toISOString() });
        try {
          // TESTING ONLY: simulate a member whose tool returns the wrong shape.
          const out = behavior.badOutput === name ? { statement: "x", proposed_refund_pct: "fifty", received: "yes" } : await h(args);
          return ok({ content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out, isError: false });
        } catch (e) {
          return ok({ content: [{ type: "text", text: String(e?.message ?? e) }], isError: true });
        }
      }
      default:
        return send(res, 200, { jsonrpc: "2.0", id: msg.id ?? null, error: { code: -32601, message: `Method '${msg.method}' not found` } });
    }
  });

  const member = {
    state,
    behavior,
    server,
    /** Credentials from registration. */
    configure: ({ memberId, platformKey, memberSecret, exchangeUrl }) => Object.assign(state, { memberId, platformKey, memberSecret, exchangeUrl: exchangeUrl ?? state.exchangeUrl }),
    listen: (port, host = "127.0.0.1") => new Promise((r) => server.listen(port, host, () => r(server.address().port))),
    close: () => new Promise((r) => (server.closeAllConnections?.(), server.close(() => r()))),
    eventsFor: (tool, taskId) => state.events.filter((e) => e.tool === tool && (!taskId || e.args.task_id === taskId)),
    api: (method, path, body) => api(method, `${state.exchangeUrl}${path}`, body),
    // Member-to-exchange calls (REST). The same operations exist as tools on the exchange's /mcp.
    heartbeat: () => api("POST", `${state.exchangeUrl}/api/members/me/heartbeat`),
    pushSkills: (skills) => ((state.skills = skills), api("PUT", `${state.exchangeUrl}/api/members/me/skills`, { skills })),
    verify: () => api("POST", `${state.exchangeUrl}/api/members/me/verify`),
    verifyAndDecide,
    /** Build (or rebuild) the tool set, e.g. after reading the exchange's protocol or a failed verification. */
    buildTools: (names) => ((allowed = names ? new Set(names) : null), (tools = buildTools()), tools.map((t) => t.name)),
    choose: (taskId, offerId) => api("POST", `${state.exchangeUrl}/api/tasks/${taskId}/choose`, { offer_id: offerId }),
  };
  return member;
}

/** Register with the exchange. Returns the registration response (member_secret and platform_key are shown once). */
export async function register(exchangeUrl, body) {
  const res = await fetch(`${exchangeUrl}/api/members/register`, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "ax-reference-member/1.0" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`register: HTTP ${res.status} ${json.error ?? ""}`);
  return json;
}

// ---------- standalone ----------
const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const env = process.env;
  const exchangeUrl = (env.AX_EXCHANGE_URL ?? "").replace(/\/$/, "");
  const roles = (env.AX_ROLES ?? "seller").split(",").map((s) => s.trim());
  const prices = JSON.parse(env.AX_PRICES ?? "{}");
  const skills = Object.entries(prices).map(([task_type, p]) => ({ task_type, description: p.description, min_price_usd: p.base_usd, typical_eta_minutes: p.eta_minutes }));
  const credsFile = env.AX_CREDENTIALS_FILE ?? "./ax-member.json";
  const authToken = env.AX_AUTH_TOKEN || undefined;
  if (!exchangeUrl || !env.AX_PUBLIC_URL) {
    console.error("Set AX_EXCHANGE_URL and AX_PUBLIC_URL (the public https URL of this server's MCP endpoint).");
    process.exit(1);
  }
  const member = createMember({ roles, skills, prices, authToken, exchangeUrl, autoDeliver: false });
  const port = await member.listen(Number(env.AX_PORT ?? 8790), env.AX_HOST ?? "0.0.0.0");
  console.log(`[member] MCP server listening on :${port}`);
  let creds = fs.existsSync(credsFile) ? JSON.parse(fs.readFileSync(credsFile, "utf8")) : null;
  if (!creds) {
    const r = await register(exchangeUrl, {
      roles, name: env.AX_NAME ?? "Reference member", contact_email: env.AX_EMAIL, mcp_url: env.AX_PUBLIC_URL, auth_token: authToken, skills,
      identity: { agent_framework: "ax-reference-member", agent_model: env.AX_MODEL, operator_name: env.AX_OPERATOR, operator_website: env.AX_WEBSITE },
    });
    creds = { memberId: r.member.id, memberSecret: r.member_secret, platformKey: r.platform_key };
    fs.writeFileSync(credsFile, JSON.stringify(creds, null, 2), { mode: 0o600 });
    console.log(`[member] registered as ${creds.memberId}; credentials saved to ${credsFile}`);
  }
  member.configure({ ...creds, exchangeUrl });
  const v = await member.verify();
  console.log(`[member] verification: ${v.status}`, v.checks.filter((c) => !c.ok));
  setInterval(() => member.heartbeat().catch((e) => console.error("[member] heartbeat failed:", e.message)), 6 * 3600_000);
}
