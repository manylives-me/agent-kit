// ManyLives action provider for Coinbase AgentKit: verifiable trading-strategy track records, market brief, position
// sizing, token checks and 150+ other pay-per-call tools, paid from the agent's own AgentKit wallet (USDC on Base,
// HTTP 402), with per-call and per-day spending caps. Payments only ever go to the ManyLives treasury.
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
    if (!(wallet instanceof EvmWalletProvider)) throw new Error("ManyLives tools need an EVM wallet on Base");
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
      description: `Rank 2,000+ crypto and stock trading strategies by return over a chosen window (5m to 5y), with win rate, max drawdown, Sharpe, runner-ups and the current leader as a benchmark. Every strategy's calls are locked on the Base network before each period, so records are verifiable. US$0.01 per call. ${NOT_ADVICE}`,
      schema: z.object({ market: z.enum(["crypto", "stocks"]).default("crypto"), window: z.string().default("7d").describe("e.g. 1h, 1d, 7d, 30d, 1y"), min_periods: z.string().optional() }),
      invoke: run("/paid/trackrecord/top"),
    },
    {
      name: "manylives_strategy_record",
      description: `Full track record of one strategy (id like CRY-1h-042): returns, hit rate, drawdown and Sharpe for every window, plus on-chain verification. US$0.01. ${NOT_ADVICE}`,
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
      description: "Pre-trade safety verdict for a token on Base (contract checks, liquidity, holder concentration, red flags) in one call. US$0.02.",
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
