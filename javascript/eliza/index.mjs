// ManyLives plugin for ElizaOS: verifiable trading-strategy track records, market brief, position sizing and token
// verdicts for trading agents. Pay per call (a US-dollar stablecoin on the Base network, HTTP 402) from a small dedicated wallet set in
// MANYLIVES_PRIVATE_KEY, with caps (MANYLIVES_MAX_USD_PER_CALL, MANYLIVES_MAX_USD_PER_DAY); without a key the free
// trial gives 3 calls a day per IP. Payments only ever go to the ManyLives treasury.
import { createClient } from "manylives-paid-tools";

const NOT_ADVICE = "General information only, not financial advice.";
let client = null;
const clientOf = (runtime) => {
  if (!client) {
    const key = runtime.getSetting("MANYLIVES_PRIVATE_KEY");
    client = createClient({
      privateKey: typeof key === "string" && /^0x[0-9a-fA-F]{64}$/.test(key) ? key : undefined,
      maxUsdPerCall: Number(runtime.getSetting("MANYLIVES_MAX_USD_PER_CALL") ?? 0.05) || 0.05,
      maxUsdPerDay: Number(runtime.getSetting("MANYLIVES_MAX_USD_PER_DAY") ?? 1) || 1,
    });
  }
  return client;
};
const textOf = (message) => String(message?.content?.text ?? "");
const num = (t, re) => { const m = t.match(re); return m ? Number(m[1].replace(/,/g, "")) : undefined; };

function action(name, similes, description, path, inputFrom, summarise, example) {
  return {
    name, similes, description,
    validate: async (_runtime, message) => !!inputFrom(textOf(message)),
    handler: async (runtime, message, _state, _options, callback) => {
      const input = inputFrom(textOf(message));
      try {
        const data = await clientOf(runtime).call(path, input);
        const text = `${summarise(data)}\n\n${NOT_ADVICE}`;
        await callback?.({ text, actions: [name], source: "manylives" });
        return { success: true, text, data };
      } catch (e) {
        const text = `ManyLives ${path} failed: ${String(e?.message ?? e)}`;
        await callback?.({ text, actions: [name], source: "manylives" });
        return { success: false, text, error: String(e?.message ?? e) };
      }
    },
    examples: [[{ name: "{{user1}}", content: { text: example } }, { name: "{{agentName}}", content: { text: "Here's what ManyLives shows…", actions: [name] } }]],
  };
}

const pct = (x) => (x === null || x === undefined ? "n/a" : `${Number(x).toFixed(2)}%`);

export const manylivesPlugin = {
  name: "manylives",
  description: "Verifiable trading-strategy track records, market brief, position sizing and token verdicts for trading agents (pay per call).",
  actions: [
    action("MANYLIVES_TOP_STRATEGIES", ["BEST_STRATEGIES", "TOP_TRADING_STRATEGIES", "STRATEGY_LEADERBOARD"],
      "Rank 1,000 verifiable crypto trading strategies by return after costs or hit rate over a window of whole days (e.g. 1d, 7d, 30d), using only calls locked on the Base network before each period.",
      "/paid/trackrecord/top",
      (t) => /strateg|leaderboard|top perform|best perform|backtest/i.test(t) ? { market: "crypto", window: (t.match(/\b(\d+\s?(?:d|w|mo|y))\b/i)?.[1] ?? "7d").replace(/\s/g, "") } : null,
      (d) => `Top strategies (${d.window ?? ""}, after costs): ` + (d.top ?? d.results ?? d.strategies ?? []).slice(0, 5).map((r, i) => `${i + 1}. ${r.id} ${pct(r.return_pct_after_costs ?? r.return_pct)}${r.hit_rate != null ? ` hit ${Math.round(r.hit_rate * 100)}%` : ""}`).join("; ") + ". Verify any of them with the record and verify services.",
      "Which crypto trading strategies performed best over the last 7d?"),
    action("MANYLIVES_MARKET_BRIEF", ["MARKET_OVERVIEW", "CRYPTO_BRIEF", "MARKET_SNAPSHOT"],
      "One-call market brief: prices, Fear & Greed, funding rates, prediction markets and FX.",
      "/paid/market/brief",
      (t) => /market (brief|overview|snapshot|update)|how.*market|fear.*greed|funding rate/i.test(t) ? { coins: [...new Set((t.match(/\b[A-Z]{2,6}\b/g) ?? []).filter((x) => !["USD", "AND", "THE", "FX"].includes(x)))].slice(0, 10).join(",") || "BTC,ETH,SOL" } : null,
      (d) => `Prices: ${(d.prices ?? []).map((p) => `${p.symbol} $${Number(p.usd).toLocaleString()}`).join(", ")}. Fear & Greed: ${d.fear_greed?.score ?? "n/a"} (${d.fear_greed?.classification ?? ""}).`,
      "Give me a quick crypto market brief for BTC and ETH"),
    action("MANYLIVES_POSITION_SIZE", ["POSITION_SIZE", "RISK_CALCULATOR", "HOW_MUCH_TO_BUY"],
      "Position size, money at risk, reward-to-risk and liquidation estimate from account size, risk %, entry and stop.",
      "/paid/trading/risk",
      (t) => {
        const account = num(t, /account(?: size)?\s*(?:of|is|=|:)?\s*\$?([\d,]+(?:\.\d+)?)/i), risk = num(t, /risk(?:ing)?\s*(?:of|=|:)?\s*([\d.]+)\s*%/i);
        const entry = num(t, /entry\s*(?:at|=|:)?\s*\$?([\d,]+(?:\.\d+)?)/i), stop = num(t, /stop(?:-loss| loss)?\s*(?:at|=|:)?\s*\$?([\d,]+(?:\.\d+)?)/i);
        if ([account, risk, entry, stop].some((x) => x === undefined)) return null;
        const target = num(t, /target\s*(?:at|=|:)?\s*\$?([\d,]+(?:\.\d+)?)/i), lev = num(t, /([\d.]+)\s*x\b/i);
        return { account: String(account), risk_pct: String(risk), entry: String(entry), stop: String(stop), ...(target ? { target: String(target) } : {}), ...(lev ? { leverage: String(lev) } : {}) };
      },
      (d) => `${d.side} ${d.position_units} units (notional $${d.notional_usd}), risking $${d.risk_usd}${d.reward_to_risk ? `, reward-to-risk ${d.reward_to_risk}` : ""}${d.liquidation_price_est ? `, liquidation ≈ ${d.liquidation_price_est}` : ""}.`,
      "Account 10000, risk 1%, entry 120000, stop 117600, target 124800, 10x — what size?"),
    action("MANYLIVES_TOKEN_VERDICT", ["TOKEN_SAFETY", "IS_TOKEN_SAFE", "CHECK_TOKEN"],
      "Pre-trade safety verdict for a token contract on the Base network.",
      "/paid/token/verdict",
      (t) => { const a = t.match(/0x[0-9a-fA-F]{40}/)?.[0]; return a && /token|safe|rug|scam|verdict|check/i.test(t) ? { token: a } : null; },
      (d) => `Verdict: ${d.verdict ?? d.summary ?? JSON.stringify(d).slice(0, 200)}`,
      "Is token 0x4200000000000000000000000000000000000006 safe to buy?"),
  ],
};

export default manylivesPlugin;
