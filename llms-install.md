# Installing the ManyLives MCP server

ManyLives is a remote MCP server; nothing to install or build, and no API key.

- URL: `https://api.manylives.me/mcp` (Streamable HTTP)
- Example client config:

```json
{ "mcpServers": { "manylives": { "type": "streamable-http", "url": "https://api.manylives.me/mcp" } } }
```

Start with the free tools `get_strategy_leaderboard` and `find_paid_tools`. Paid HTTP tools need a wallet holding a US-dollar stablecoin on the Base network; to call them from MCP with spending caps, use the local package `npx manylives-paid-tools` (optional `MANYLIVES_PRIVATE_KEY` of a small dedicated wallet; without it, free trial calls only).
