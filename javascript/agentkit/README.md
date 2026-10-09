# manylives-agentkit

A [Coinbase AgentKit](https://github.com/coinbase/agentkit) action provider for [ManyLives](https://manylives.me/trading). It gives your agent:

- verifiable track records for 2,000+ trading strategies;
- a one-call market brief;
- position sizing;
- token safety verdicts;
- 150+ other pay-per-call tools.

Calls are paid per use from the agent's own AgentKit wallet, in USDC on Base over HTTP 402. There is no account and no API key.

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
| `manylives_top_strategies` | US$0.01 | Ranks strategies by return over any window, with win rate, drawdown, Sharpe and the current leader. |
| `manylives_strategy_record` | US$0.01 | Full record of one strategy. |
| `manylives_verify_strategy` | US$0.01 | On-chain proof that a call was locked before its period started. |
| `manylives_market_brief` | US$0.02 | Prices, Fear & Greed, funding rates, prediction markets and FX in one call. |
| `manylives_position_size` | US$0.005 | Position size, risk, reward-to-risk and an estimated liquidation price. |
| `manylives_token_verdict` | US$0.02 | Pre-trade safety verdict for a token on Base. |
| `manylives_call` | varies | Any other service from the [catalogue](https://api.manylives.me/paid). |

## Safety

- Payments go only to the ManyLives treasury. The client refuses any other receiver.
- Your per-call and per-day caps are enforced before anything is signed.
- Calls that fail or are refused are not charged.

General information only. Nothing here is financial advice. Past performance is not an indicator of future results.
