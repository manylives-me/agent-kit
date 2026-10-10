# manylives-agentkit

A [Coinbase AgentKit](https://github.com/coinbase/agentkit) action provider for [ManyLives](https://manylives.me/trading). It gives your agent:

- verifiable track records for 1,000 crypto trading strategies;
- a one-call market brief;
- position sizing;
- token safety verdicts;
- 150+ other pay-per-call tools.

Calls are paid per use from the agent's own AgentKit wallet, in a US-dollar stablecoin on the Base network over HTTP 402. There is no account and no API key.

```ts
import { AgentKit } from "@coinbase/agentkit";
import { manylivesActionProvider } from "manylives-agentkit";

const agentkit = await AgentKit.from({
  walletProvider,
  actionProviders: [manylivesActionProvider({ maxUsdPerCall: 0.05, maxUsdPerDay: 1 })],
});
```

## Actions

| Action | Price | What it does |
|---|---|---|
| `manylives_top_strategies` | US$0.01 | Ranks 1,000 crypto strategies by return after costs or hit rate over a window of whole days (e.g. 1d, 7d, 30d), using only calls locked on the Base network before each period (since 9 Oct 2026). |
| `manylives_strategy_record` | US$0.01 | Full record of one strategy: daily results, every period for daily and slower books, its on-chain commits, and returns over 7/30/365 days and all time. |
| `manylives_verify_strategy` | US$0.01 | On-chain proof that a call was locked before its period started. |
| `manylives_market_brief` | US$0.02 | Prices, Fear & Greed, funding rates, prediction markets and FX in one call. |
| `manylives_position_size` | US$0.005 | Position size, risk, reward-to-risk and an estimated liquidation price. |
| `manylives_token_verdict` | US$0.02 | Pre-trade safety verdict for a token on the Base network. |
| `manylives_call` | varies | Any other service from the [catalogue](https://api.manylives.me/paid). |

## Safety

- Payments go only to the ManyLives treasury. The client refuses any other receiver.
- Your per-call and per-day caps are enforced before anything is signed.
- Calls that fail or are refused are not charged.

General information only. Nothing here is financial advice. Past performance is not an indicator of future results.
