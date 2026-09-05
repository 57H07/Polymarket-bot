# 🚀 Step-by-Step Guide: From Zero to Live Trading

This guide takes you from a fresh computer to a running bot, in two stages:

1. **Simulation** (no money, no private key). You learn the dashboard, watch the bot trade a paper account against the real Polymarket orderbooks, and decide whether a strategy is worth real money.
2. **Live** (real money, dedicated wallet, tiny amounts). Only after the simulation has convinced you.

Nothing in this guide requires programming knowledge. When you see a grey box, copy the line into your terminal and press Enter.

> ⚠️ **Read this once.** This bot can lose all the money you give it. Its safety limits reduce losses, they do not prevent them. Never put in more than you can afford to lose entirely, and never use your main wallet.

---

## Part 0 — Install (15 minutes, once)

### 0.1 Install the tools

| Tool | Why | Where |
|------|-----|-------|
| **Node.js 18 or newer** | runs the bot | https://nodejs.org (choose "LTS") |
| **Git** | downloads the code | https://git-scm.com |

After installing, open a terminal (Windows: "PowerShell", Mac: "Terminal") and check:

```bash
node --version
git --version
```

Both must print a version number. If not, restart the terminal or your computer.

### 0.2 Download the bot

```bash
git clone https://github.com/57H07/Polymarket-bot.git
cd Polymarket-bot
```

### 0.3 Install the bot and build the dashboard

```bash
npm install
cd dashboard
npm install
npm run build
cd ..
```

The dashboard build is required: without it the bot runs but the web page stays blank.

### 0.4 Check that everything works

```bash
npm test
```

You should see `Tests  82 passed`. If you see errors, delete the `node_modules` folder and run `npm install` again.

---

## Part 1 — Simulation (2 weeks minimum)

Simulation mode is not a fake counter. The bot runs its real strategies and fills orders against the **real Polymarket orderbook**, level by level, with the real prices, the real depth, and a gas cost on every on-chain operation. What differs from live: no money moves, and your own orders do not affect the market (so real results will be slightly worse).

### 1.1 Create your settings file

Copy the example file:

```bash
cp .env.example .env
```

(Windows PowerShell: `copy .env.example .env`)

Open `.env` with any text editor and make it look like this:

```env
# Leave empty for simulation, no key needed
POLYMARKET_PRIVATE_KEY=

# Your virtual budget for the paper account
CAPITAL_USD=50

# true = simulation
DRY_RUN=true

# Strategies: start with ONE. DipArb is the most interesting one.
ARBITRAGE_ENABLED=false
DIPARB_ENABLED=true
SMARTMONEY_ENABLED=false
TREND_ANALYSIS_ENABLED=false
```

**Why one strategy?** If you enable everything, you will not know which one made or lost the money.

### 1.2 Start the bot

```bash
npx tsx bot-with-dashboard.ts
```

The terminal shows startup logs, then a status box every minute. Open the dashboard in your browser:

**http://localhost:3001**

The header must say **🧪 SIMULATION**. If it says LIVE, stop the bot immediately (Ctrl+C in the terminal) and check `DRY_RUN=true` in `.env`.

### 1.3 Read the dashboard

| Panel | What it means |
|-------|---------------|
| **Paper cash / Equity / Realised / Unrealised** | Your virtual account. *Equity* = cash + value of open positions. *Realised* = money actually won or lost on closed trades. *Unrealised* = paper gain/loss on positions still open. |
| **Risk Status** | Daily, monthly, drawdown and total-loss limits. Green = fine, red = the bot paused itself. |
| **Streak** (terminal status box) | Consecutive wins / losses and the size of the next trade. Sizes shrink after losses and grow after wins. |
| **Positions** page | Every open position with its entry price, current price and PnL. |
| **Activity log** | What the bot is doing. Lines starting with `[SIM]` are simulated fills. |
| **History** page | Summary of past sessions (written each time you stop the bot). |

Useful log lines to recognise:

- `DipArb OPEN UP | 10.0 sh @ $0.420` → the bot bought the dip (leg 1).
- `DipArb HEDGE DOWN | ...` → the other side was bought (leg 2). The pair is now locked.
- `DipArb MERGE 10.0 pairs → $10.00 | cost $9.10 + gas $0.10 | realised $0.80` → profit booked.
- `DipArb CLOSE UP (timeout)` → no hedge came in time, leg 1 was sold, usually at a loss.
- `FOK not filled` → the orderbook did not have enough depth at that price. The real exchange would have refused too.
- `Copy skipped (maxPerMarket ...)` → an exposure limit blocked a trade. This is normal.

### 1.4 Let it run

Leave the bot running for **at least two weeks**. Stop it with **Ctrl+C** in the terminal when you need to; the paper account, positions and risk counters are saved in the `data/` folder and restored on the next start.

To start over from a clean account, click **Reset sim** in the dashboard, or start with `PAPER_RESET=true`:

```bash
PAPER_RESET=true npx tsx bot-with-dashboard.ts
```

(Windows PowerShell: `$env:PAPER_RESET="true"; npx tsx bot-with-dashboard.ts`)

### 1.5 Judge the result honestly

After two weeks, look at these numbers, not at the green/red colour of the day:

| Question | Where | Go live only if |
|----------|-------|-----------------|
| Did it make money **after gas**? | Realised PnL in the dashboard, gas in the terminal status box | Realised PnL is clearly positive, not a few cents |
| For DipArb: how many opened legs got hedged? | Count `MERGE` vs `CLOSE ... (timeout)` lines in the log | At least 60% hedged |
| How many orders failed? | Count `FOK not filled` lines | Few. Many failures mean the markets are too thin for your size |
| Did the risk limits trigger? | Risk Status panel, `Daily loss limit breached` lines | You understand why they triggered |
| Is the result stable? | Compare week 1 and week 2 | Both weeks positive |

If the answer to any row is "no", change the strategy or its settings and simulate again. Real money will not fix a strategy that loses on paper.

### 1.6 Try the other strategies (optional)

Repeat 1.1 to 1.5 with **one** other strategy at a time:

- `ARBITRAGE_ENABLED=true`: buys YES+NO when they cost less than $1 together and merges them. Rare opportunities, very competitive.
- `SMARTMONEY_ENABLED=true`: copies wallets from the leaderboard that pass the quality filters. Needs the WebSocket to be connected (`Connected to WebSocket server` in the logs).
- `TREND_ANALYSIS_ENABLED=true` + Direct trading toggle in the dashboard: buys crypto markets following the Binance 15-minute trend, with stop-loss and take-profit. Prototype, keep it small.

---

## Part 2 — Live trading (only after Part 1)

### 2.1 Create a dedicated wallet

Never use a wallet that holds anything else.

1. In MetaMask (or any wallet), create a **new account**. Name it "Polymarket bot".
2. Export its **private key** (MetaMask: account menu → Account details → Show private key). It starts with `0x` and has 64 characters after it.
3. Treat that key like cash: anyone who has it owns the wallet.

### 2.2 Register the wallet on Polymarket

The bot trades through Polymarket's exchange, which must know the wallet:

1. Go to https://polymarket.com and log in **with that new wallet** (Connect wallet → MetaMask).
2. Accept the terms. You do not need to trade by hand.

Without this step the bot stops with `Failed to create or derive API key. Wallet may not be registered on Polymarket.`

### 2.3 Fund the wallet (small)

You need two things on the **Polygon** network:

| Token | Amount for a first live test | Why |
|-------|------------------------------|-----|
| **USDC.e** (bridged USDC, contract `0x2791...4174`) | 20 to 50 | trading capital. Polymarket does **not** accept native USDC |
| **POL / MATIC** | 2 to 5 | gas for approvals, merges and redeems |

The simplest way: deposit on polymarket.com with a card or from an exchange, then withdraw to your bot wallet address. Or send from an exchange that supports withdrawals on Polygon, choosing **USDC.e** explicitly.

Check the balances on https://polygonscan.com by pasting your wallet address.

### 2.4 Switch the settings to live

Edit `.env`:

```env
POLYMARKET_PRIVATE_KEY=0xYOUR_NEW_WALLET_PRIVATE_KEY
CAPITAL_USD=20
DRY_RUN=false

# Same single strategy you validated in simulation
DIPARB_ENABLED=true
ARBITRAGE_ENABLED=false
SMARTMONEY_ENABLED=false
TREND_ANALYSIS_ENABLED=false

# Keep the dashboard private
DASHBOARD_HOST=127.0.0.1
ALLOW_DASHBOARD_LIVE_TOGGLE=false
```

`CAPITAL_USD` is your risk budget, not your wallet balance. All limits (5% daily loss, 40% total halt, position sizes) are computed from it. Start with the amount you actually deposited.

### 2.5 Start live

```bash
npx tsx bot-with-dashboard.ts
```

On the first live start the bot sends **approval transactions** (it lets the Polymarket contracts spend your USDC.e and move your outcome tokens). This costs a little MATIC and takes a minute. You will see `✅ All approvals ready`.

The dashboard header must now say **🔴 LIVE**.

### 2.6 What to check every day

1. **Reconcile.** Compare the bot's Total PnL with your real balance: USDC.e on polygonscan + open positions on polymarket.com/portfolio, minus what you deposited. If the two disagree by more than a few cents, stop and investigate before adding money.
2. **Look for red.** Risk Status panel and any `paused`, `halted`, `failed` line in the log.
3. **Gas.** MATIC balance above 0.5. Below that, merges and redeems fail and profits stay locked in tokens.
4. **Stuck positions.** On the Positions page, a market marked closed with tokens still held → click **Redeem**.

### 2.7 Scale up only when live matches simulation

After 2 to 4 weeks live with the small budget: if the live results are close to what the simulation showed, raise `CAPITAL_USD` (and deposit accordingly). If live is much worse than simulation, the difference is slippage and competition; do not scale.

### 2.8 Stop the bot

- **Normal stop:** Ctrl+C in the terminal. The bot saves its state and writes the session to History.
- **Emergency:** Ctrl+C, then on polymarket.com close positions by hand if needed.
- **Permanent halt:** if the bot printed `TOTAL LOSS LIMIT REACHED`, it will refuse to trade until you delete `data/risk-state.live.json`. Think before you do.

---

## Part 3 — Safety checklist

- [ ] The bot wallet holds nothing but the trading budget and a little MATIC.
- [ ] `.env` is never shared, screenshotted or committed. It is in `.gitignore`.
- [ ] The dashboard is only reachable on your own computer (`DASHBOARD_HOST=127.0.0.1`). If you must open it to your network, set `DASHBOARD_TOKEN=some-long-secret` and open `http://<host>:3001/?token=some-long-secret`.
- [ ] `ALLOW_DASHBOARD_LIVE_TOGGLE` stays `false`. Switch to live by editing `.env` and restarting.
- [ ] One strategy at a time.
- [ ] The computer stays on and connected while the bot runs (a small VPS or an old laptop works). If the bot is off, open positions are not managed.

---

## Part 4 — Troubleshooting

| Message | Meaning | Fix |
|---------|---------|-----|
| `Dashboard port 3001 is already in use` | another bot is still running | close it, or set `DASHBOARD_PORT=3002` |
| `Realtime WebSocket not connected yet` | Polymarket's live feed is unreachable | the bot keeps retrying with growing delays; DipArb and Smart Money need this feed |
| `No DipArb markets found` | no 15-minute crypto market open right now | wait, they open every 15 minutes |
| `Failed to create or derive API key` | wallet not registered on Polymarket (live only) | do step 2.2 |
| `Insufficient USDC.e` | wallet holds native USDC or nothing | send USDC.e (bridged), see 2.3 |
| `FOK not filled` | not enough liquidity at that price | normal, lower `CAPITAL_USD` if it happens constantly |
| `Refused: switching to LIVE from the dashboard is disabled` | you clicked "Switch to LIVE" | intended. Edit `.env` and restart |
| Dashboard page is blank | dashboard not built | run step 0.3 again |
| `TOTAL LOSS LIMIT REACHED` | you lost 40% of `CAPITAL_USD` | stop, review, delete `data/risk-state.live.json` only if you really want to continue |

Still stuck? Copy the last 50 lines of the terminal and open an issue on the repository. Never paste your `.env`.
