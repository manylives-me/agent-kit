# plugin-manylives (ElizaOS)

This plugin gives an [ElizaOS](https://github.com/elizaOS/eliza) trading agent verifiable trading data from [ManyLives](https://manylives.me/trading).

| Action | What it does |
|---|---|
| `MANYLIVES_TOP_STRATEGIES` | Ranks 1,000 crypto strategies by return after costs or hit rate over a window of days, using only calls locked on the Base network before each period (since 9 Oct 2026). |
| `MANYLIVES_MARKET_BRIEF` | Prices, Fear & Greed, funding rates, prediction markets and FX in one call. |
| `MANYLIVES_POSITION_SIZE` | Position size, money at risk, reward-to-risk and a liquidation estimate. |
| `MANYLIVES_TOKEN_VERDICT` | Pre-trade safety verdict for a token on the Base network. |

```ts
import { manylivesPlugin } from "plugin-manylives";
// character: { plugins: [manylivesPlugin], settings: { secrets: { MANYLIVES_PRIVATE_KEY: "0x…" } } }
```

## Payment

You pay per call, US$0.005 to US$0.02, in a US-dollar stablecoin on the Base network. There is no account and no API key.

- `MANYLIVES_PRIVATE_KEY`: the key of a small dedicated wallet. Without it, the free trial gives 3 calls a day per IP (trials can run out for the day).
- `MANYLIVES_MAX_USD_PER_CALL` and `MANYLIVES_MAX_USD_PER_DAY`: spending caps.

Payments go only to the ManyLives treasury.

General information only. Nothing here is financial advice.
