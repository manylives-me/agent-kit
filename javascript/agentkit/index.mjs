// ManyLives action provider for Coinbase AgentKit: verifiable trading-strategy track records, market brief, position
// sizing, token checks and 150+ other pay-per-call tools, paid from the agent's own AgentKit wallet (a US-dollar stablecoin
// on the Base network, HTTP 402), with per-call and per-day spending caps. Payments only ever go to the ManyLives treasury.
import { customActionProvider, EvmWalletProvider } from "@coinbase/agentkit";
import { createClient } from "manylives-paid-tools";
import { z } from "zod";

const NOT_ADVICE = "General information only, not financial advice.";

/**
 * @param {object} [opts]
 * @param {number} [opts.maxUsdPerCall=0.05]  refuse any call priced above this
 * @param {number} [opts.maxUsdPerDay=1]      stop paying after this much per day (per process)
 */
export function manylivesActionProvider(opts = {}) {
  const clients = new WeakMap();
  const clientFor = (wallet) => {
    if (!(wallet instanceof EvmWalletProvider)) throw new Error("ManyLives tools need an EVM wallet on the Base network");
    if (!clients.has(wallet)) clients.set(wallet, createClient({ account: wallet.toSigner(), maxUsdPerCall: opts.maxUsdPerCall ?? 0.05, maxUsdPerDay: opts.maxUsdPerDay ?? 1 }));
    return clients.get(wallet);
  };
  const run = (path, pick) => async (wallet, args) => {
    try { return JSON.stringify(await clientFor(wallet).call(path, pick ? pick(args) : args)); }
    catch (e) { return JSON.stringify({ error: String(e?.message ?? e) }); }
  };
  return customActionProvider([
    {
      name: "manylives_top_strategies",
      description: `Rank 1,000 crypto trading strategies by return after costs (or hit rate or significance) over a window of whole days you pick (e.g. 1d, 7d, 30d), using only calls locked on the Base network before each period (record since 9 Oct 2026; weekly and monthly books have no scored periods until their first period ends). Returns each strategy's return before and after costs, hit rate, periods and a luck check against coin-flip strategies. US$0.01 per call. ${NOT_ADVICE}`,
      schema: z.object({ market: z.enum(["crypto"]).default("crypto"), window: z.string().default("7d").describe("whole days, e.g. 1d, 7d, 30d, or a start date YYYY-MM-DD"), min_periods: z.string().optional() }),
      invoke: run("/paid/trackrecord/top"),
    },
    {
      name: "manylives_strategy_record",
      description: `Full record of one strategy (id like CRY-1d-007): daily results, every period for daily and slower books, its on-chain commits, and returns over 7/30/365 days and all time. US$0.01. ${NOT_ADVICE}`,
      schema: z.object({ id: z.string() }),
      invoke: run("/paid/trackrecord/record"),
    },
    {
      name: "manylives_verify_strategy",
      description: "Merkle proof and Base network transaction showing a strategy's call was locked before the period started. US$0.01.",
      schema: z.object({ id: z.string(), period: z.string().optional() }),
      invoke: run("/paid/trackrecord/verify"),
    },
    {
      name: "manylives_market_brief",
      description: `One-call market brief: live prices, crypto Fear & Greed, perpetual funding rates, busiest prediction markets on a topic and FX rates. US$0.02. ${NOT_ADVICE}`,
      schema: z.object({ coins: z.string().default("BTC,ETH,SOL"), topic: z.string().default("bitcoin") }),
      invoke: run("/paid/market/brief"),
    },
    {
      name: "manylives_position_size",
      description: `Position size, money at risk, reward-to-risk, break-even win rate and estimated liquidation price from account size, risk %, entry, stop (optional target and leverage). Arithmetic only. US$0.005. ${NOT_ADVICE}`,
      schema: z.object({ account: z.number(), risk_pct: z.number(), entry: z.number(), stop: z.number(), target: z.number().optional(), leverage: z.number().optional() }),
      invoke: run("/paid/trading/risk", (a) => Object.fromEntries(Object.entries(a).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]))),
    },
    {
      name: "manylives_token_verdict",
      description: "Pre-trade safety verdict for a token on the Base network (contract checks, liquidity, holder concentration, red flags) in one call. US$0.02.",
      schema: z.object({ token: z.string().describe("token contract address 0x…") }),
      invoke: run("/paid/token/verdict"),
    },
    {
      name: "manylives_call",
      description: "Call any other ManyLives pay-per-call service by path (catalogue: https://api.manylives.me/paid), e.g. /paid/crypto/price with {coins: 'BTC,ETH'}. Spending caps apply.",
      schema: z.object({ path: z.string().describe("e.g. /paid/crypto/funding"), input: z.record(z.any()).default({}) }),
      invoke: async (wallet, args) => { try { return JSON.stringify(await clientFor(wallet).call(args.path, args.input)); } catch (e) { return JSON.stringify({ error: String(e?.message ?? e) }); } },
    },
  ]);
}

export default manylivesActionProvider;
