# manylives-paid-tools

150+ pay-per-call tools for AI agents from [ManyLives](https://manylives.me/trading): verifiable trading-strategy track records, token verdicts, web page extraction, crypto and on-chain data, text AI, site and MCP audits, and more. No account and no API key. Each call costs US$0.002 to US$0.25 (most under US$0.05; the default cap refuses anything above US$0.05), paid in a US-dollar stablecoin on the Base network from **your own wallet**, with spend caps you set.

**Try it free:** without a wallet key most tools run on the free trial: 3 calls a day per IP (some tools, e.g. image, memory, inbox, schedule, screenshots, have no trial; trials can also run out for the day). The [strategy leaderboard](https://manylives.me/leaderboard) is free too (JSON: <https://api.manylives.me/trackrecord>), ranked only on calls stamped on-chain.

## Use it from Claude, Cursor or any MCP client

```bash
claude mcp add manylives -- npx -y manylives-paid-tools
```

Or in a JSON MCP config (Claude Desktop, Cursor, Windsurf…):

```json
{
  "mcpServers": {
    "manylives": {
      "command": "npx",
      "args": ["-y", "manylives-paid-tools"],
      "env": {
        "MANYLIVES_WALLET_KEY": "0x… (optional: a small dedicated Base network wallet holding a few dollars of a US-dollar stablecoin)",
        "MANYLIVES_MAX_USD_PER_CALL": "0.05",
        "MANYLIVES_MAX_USD_PER_DAY": "1",
        "MANYLIVES_TOOLS": "token_verdict,web_extract_fields,site_agent_report"
      }
    }
  }
}
```

`MANYLIVES_TOOLS` is optional; leave it out to expose every tool.

## Use it in code

```js
import { createClient } from "manylives-paid-tools";

const ml = createClient({ privateKey: process.env.WALLET_KEY, maxUsdPerCall: 0.05, maxUsdPerDay: 1 });
const v = await ml.call("token/verdict", { token: "0x940181a94A35A4569E4529A3CDfB74e38FD98631" });
console.log(v.risk, v.flags, v.verdict);
```

### Find strategies with verifiable track records

1,000 crypto strategies make next-period up/down calls (5-minute to monthly) that are locked on the Base network before each period and scored afterwards (record since 9 Oct 2026). Rank them over a window of days, or as of a past date in the record, and verify any call yourself.

```js
const top = await ml.call("trackrecord/top", { horizon: "1h", window: "7d", sort: "return" });
const luck = await ml.call("trackrecord/luck", { id: top.top[0].id });   // skill or luck?
const proof = await ml.call("trackrecord/verify", { id: top.top[0].id }); // Merkle proof + Base tx
```

General information only: past performance is not an indicator of future performance; not financial advice.

### Trading bots: check a token before you trade it (US$0.02)

```js
const v = await ml.call("token/verdict", { token });
if (v.risk === "high" || (v.market.impact_1000_usd_pct ?? 100) > 3) return skip(token, v.flags);
```

You get contract control (owner, upgradeable, concentration), live price and the price impact of a 1,000-dollar sell, the last five minutes of transfers, trend indicators, perp funding when a market exists, red flags, a risk level and a plain-language verdict. Data, not financial advice.

### Vercel AI SDK

```js
import { tool, jsonSchema } from "ai";
const tools = Object.fromEntries((await ml.tools({ only: ["token_verdict", "web_extract_fields"] }))
  .map((t) => [t.name, tool({ description: t.description, inputSchema: jsonSchema(t.parameters), execute: t.execute })]));
```

### LangChain.js

```js
import { DynamicStructuredTool } from "@langchain/core/tools";
const tools = (await ml.tools()).map((t) => new DynamicStructuredTool({
  name: t.name, description: t.description, schema: t.parameters,
  func: async (input) => JSON.stringify(await t.execute(input)),
}));
```

`ml.tools()` returns plain `{ name, description, parameters (JSON Schema), execute }` objects, so any framework that takes JSON Schema tools works the same way.

## Safety

- Payments go only to the ManyLives treasury (`0xD161874249321F8AE3000C19DdD070e46682f1B3`) in a US-dollar stablecoin on the Base network; anything else is refused.
- Calls priced above `maxUsdPerCall` are refused; payments stop at `maxUsdPerDay` (per process).
- Bad input is never charged: the service checks input before the payment settles.
- Use a dedicated wallet with a small balance, never your main wallet.

Full catalogue with prices and inputs: <https://api.manylives.me/paid>. MIT licence.
