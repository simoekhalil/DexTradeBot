# Gala Bot — Connect API (Patched)

This version includes:
- **Use cap**: MAX_USES_PER_TRADE
- **Dust filter**: MIN_PER_USE_USD
- **Profit-after-fee** in USD (converts GALA fees to USD)

## Setup
1) Install Node.js LTS
2) Unzip this folder
3) In a terminal inside the folder:
   npm i
   copy .env.example .env        (Windows)   # or: cp .env.example .env

## Configure .env
- WALLET_ADDRESS: client|... or eth|YOURADDRESSWITHOUT0x
- PRIVATE_KEY: 0x...
- PAIRS: e.g., GALA>SILK,GALA>GUSDC
- MIN_EDGE_BPS: e.g., 30 (0.30%)
- MAX_NOTIONAL_USD: e.g., 250
- MAX_USES_PER_TRADE: e.g., 3
- MIN_PER_USE_USD: e.g., 1
- DRY_RUN: start with true

## Run
npm start

With DRY_RUN=true it only prints what it would do. Set DRY_RUN=false to actually trade.
