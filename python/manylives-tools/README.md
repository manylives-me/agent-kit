# manylives-tools (Python)

Pay-per-call tools from [ManyLives](https://manylives.me/trading) for Python agents. They work with LangGraph/LangChain, CrewAI or plain Python. What you get:

- verifiable track records for 2,000+ trading strategies;
- a one-call market brief;
- position sizing;
- contract and token security checks;
- web and AI tools, 170+ services in all.

Each call is paid from your own wallet in USDC on Base (HTTP 402), with spending caps. There is no account or API key. Without a key you get 3 free calls a day.

```bash
pip install "manylives-tools[langchain]"   # or [crewai]
```

```python
from manylives_tools import ManyLives, langchain_tools, crewai_tools

ml = ManyLives(private_key="0x…", max_usd_per_call=0.05, max_usd_per_day=1)
ml.call("market/brief", coins="BTC,ETH")                         # plain Python
tools = langchain_tools(ml)                                      # LangGraph / LangChain StructuredTools
crew_tools = crewai_tools(ml, only=["trackrecord/top", "contract/audit"])
```

- **Payments go only to the ManyLives treasury.** The client refuses any other receiver.
- **Spending caps:** limits per call and per day are enforced before anything is signed.
- **Failed or refused calls are not charged.**

General information only. Nothing here is financial advice.
