#!/usr/bin/env node
// MCP server (stdio) exposing every ManyLives paid tool. Env: MANYLIVES_WALLET_KEY (optional; without it, free trial calls),
// MANYLIVES_MAX_USD_PER_CALL (default 0.05), MANYLIVES_MAX_USD_PER_DAY (default 1), MANYLIVES_TOOLS (optional comma list to expose).
import { createInterface } from "node:readline";
import { createClient } from "./index.mjs";

const client = createClient({
  privateKey: process.env.MANYLIVES_WALLET_KEY || undefined,
  maxUsdPerCall: Number(process.env.MANYLIVES_MAX_USD_PER_CALL || 0.05),
  maxUsdPerDay: Number(process.env.MANYLIVES_MAX_USD_PER_DAY || 1),
});
const only = process.env.MANYLIVES_TOOLS ? process.env.MANYLIVES_TOOLS.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
let toolsP = null;
const getTools = () => (toolsP ??= client.tools({ only }));
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");

async function handle(m) {
  switch (m.method) {
    case "initialize":
      return { protocolVersion: m.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} },
        serverInfo: { name: "manylives-paid-tools", version: "0.2.1" },
        instructions: client.address ? `Paid tools; each call is paid from wallet ${client.address} within your caps.` : "Paid tools running on free trial calls (3 a day). Set MANYLIVES_WALLET_KEY to pay per call." };
    case "ping": return {};
    case "tools/list": return { tools: (await getTools()).map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters })) };
    case "tools/call": {
      const t = (await getTools()).find((x) => x.name === m.params?.name);
      if (!t) return { content: [{ type: "text", text: `Unknown tool ${m.params?.name}` }], isError: true };
      try { return { content: [{ type: "text", text: JSON.stringify(await t.execute(m.params?.arguments ?? {}), null, 2) }] }; }
      catch (e) { return { content: [{ type: "text", text: String(e?.message ?? e) }], isError: true }; }
    }
    default: throw Object.assign(new Error(`Method not found: ${m.method}`), { code: -32601 });
  }
}

createInterface({ input: process.stdin }).on("line", async (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); }
  if (m.id === undefined || m.id === null) return; // notification
  try { send({ jsonrpc: "2.0", id: m.id, result: await handle(m) }); }
  catch (e) { send({ jsonrpc: "2.0", id: m.id, error: { code: e.code ?? -32603, message: String(e.message ?? e) } }); }
});
