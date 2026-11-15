// SPDX-License-Identifier: MIT
//
// EMA Trend Rider — BTC 24h
//
// A deterministic, long-only trend-following bot for the make.fun
// btc-race-24h competition. It trades one symbol (CBBTC) on 1-minute
// bars, speaking the agent-fun/bars-replay/v1 protocol over NDJSON on
// stdin/stdout: the harness sends one `hello`, then one `batch` per
// bar, then `done`; the bot answers every batch with exactly one
// `reply` echoing the batch seq, carrying its orders (at most one
// order per reply from this bot).
//
// Strategy, in plain words:
//   * Entry: the fast EMA (12 bars) sits above the slow EMA (48 bars),
//     the close sits above the slow EMA, AND the close breaks above
//     the highest high of the previous 60 bars (a Donchian breakout).
//     The breakout filter keeps the bot out of choppy, drifting
//     markets and only lets it in when price is making fresh highs
//     with the trend behind it.
//   * Sizing: each entry spends 60% of the cash on hand, one open
//     position at most.
//   * Exit: a trailing stop at the highest close since entry minus
//     3x the 14-bar average true range (ATR), or when the fast EMA
//     crosses back below the slow EMA. After an exit the bot waits
//     30 bars before it may enter again, so a whipsaw cannot make
//     it re-enter on the same chop.
//   * Orders decided on one batch fill at the next bar's open, so
//     every decision is made only from closes already seen.
//   * No network, no wall clock, no files, no randomness: the same
//     bars always produce the same orders.

import * as readline from "node:readline";

// ------------------------------------------------------------------
// Strategy parameters (plain numbers, tuned on the dev window only
// for robustness: neighbouring values all stay profitable there).
// ------------------------------------------------------------------
const FAST_PERIOD = 12; // fast EMA length, in bars
const SLOW_PERIOD = 48; // slow EMA length, in bars
const ATR_PERIOD = 14; // ATR length, in bars
const DONCHIAN_BARS = 60; // breakout lookback, in bars
const STOP_ATR = 3.0; // trailing stop distance, in ATRs
const SIZE_NUM = 70; // buy size: 70% of cash
const SIZE_DEN = 100;
const COOLDOWN_BARS = 30; // bars to wait after an exit
const MIN_BARS = 120; // bars of history before the first trade
const LAST_ENTRY_BAR = 1425; // do not open a trade in the final bars
const MAX_SLIPPAGE_BPS = 100; // 1% guard against a wild open

// ------------------------------------------------------------------
// Small helpers.
// ------------------------------------------------------------------

// Integer price strings come at price_scale 5: 1 unit = 1e-5 USD.
function priceToUsd(raw: string): number {
  return Number(raw) / 100000;
}

// ------------------------------------------------------------------
// Bot state. Everything here is derived from the hello and batch
// messages only, in the order they arrive, so two runs on the same
// data produce the same replies.
// ------------------------------------------------------------------
interface HelloInfo {
  symbol: string;
  warmupBars: number;
  minNotional: bigint;
}

let helloInfo: HelloInfo | null = null;

let barsSeen = 0; // bars received for our symbol
let emaFast: number | null = null;
let emaSlow: number | null = null;
let atr: number | null = null;
let prevClose: number | null = null;
const recentHighs: number[] = []; // highs of the last DONCHIAN_BARS bars

let entryPrice = 0; // USD fill price of the open position
let peakClose = 0; // highest close since entry, in USD
let coolUntilBar = -1; // no entries while barsSeen < this
let outstanding = false; // an order sent last batch, fill not yet seen

// ------------------------------------------------------------------
// Indicator updates. Called once per bar, with that bar's OHLC.
// ------------------------------------------------------------------
function updateIndicators(o: number, h: number, l: number, c: number): void {
  const kFast = 2 / (FAST_PERIOD + 1);
  const kSlow = 2 / (SLOW_PERIOD + 1);
  const kAtr = 2 / (ATR_PERIOD + 1);

  if (emaFast === null) {
    emaFast = c;
    emaSlow = c;
  } else {
    emaFast = c * kFast + emaFast * (1 - kFast);
    emaSlow = c * kSlow + emaSlow * (1 - kSlow);
  }

  const trueRange =
    prevClose === null
      ? h - l
      : Math.max(h - l, Math.abs(h - prevClose), Math.abs(l - prevClose));
  atr = atr === null ? trueRange : trueRange * kAtr + atr * (1 - kAtr);
  prevClose = c;

  recentHighs.push(h);
  if (recentHighs.length > DONCHIAN_BARS) recentHighs.shift();
}

function donchianHigh(): number {
  let hi = -Infinity;
  for (const h of recentHighs) if (h > hi) hi = h;
  return hi;
}

// ------------------------------------------------------------------
// Decision: given the batch, return the orders for this reply.
// ------------------------------------------------------------------
function decide(msg: any): any[] {
  const orders: any[] = [];
  if (helloInfo === null) return orders;

  const bar = (msg.bars || []).find((b: any) => b.symbol === helloInfo!.symbol);
  const fills: any[] = msg.fills || [];
  const account = msg.account || {};
  const cash: bigint = BigInt(account.cash_quote_units || "0");
  const positions: any[] = account.positions || [];
  const pos = positions.find((p: any) => p.symbol === helloInfo!.symbol);
  const posQty: bigint = pos ? BigInt(pos.qty) : 0n;

  // Acknowledge last batch's order: its fill (or rejection) is in
  // this batch. A buy fill sets the entry price and the trailing
  // peak; a sell fill closes the position.
  if (outstanding) {
    outstanding = false;
    for (const f of fills) {
      if (f.status !== "filled") continue;
      if (f.side === "buy") {
        entryPrice = priceToUsd(f.price);
        peakClose = entryPrice;
      } else if (f.side === "sell") {
        entryPrice = 0;
        peakClose = 0;
        coolUntilBar = barsSeen + COOLDOWN_BARS;
      }
    }
  }

  // No bar for our symbol this batch: nothing to decide on.
  if (!bar) return orders;

  const o = priceToUsd(bar.o);
  const h = priceToUsd(bar.h);
  const l = priceToUsd(bar.l);
  const c = priceToUsd(bar.c);

  // The breakout is judged against the highs of the previous bars
  // only: this bar's own high must not count, or the close could
  // never beat it. Capture it before the update pushes this bar.
  const prevDonchianHigh = donchianHigh();

  updateIndicators(o, h, l, c);
  barsSeen += 1;

  // Respect the hello warmup: no orders while the harness is still
  // warming up, and no trading until the indicators have enough
  // history behind them.
  if (msg.seq < helloInfo.warmupBars) return orders;
  if (barsSeen < MIN_BARS) return orders;
  if (emaFast === null || emaSlow === null || atr === null) return orders;

  const inPosition = posQty > 0n;

  if (inPosition) {
    // Track the trailing stop from the highest close since entry.
    if (c > peakClose) peakClose = c;
    const stop = peakClose - STOP_ATR * atr;
    const trendReversed = emaFast < emaSlow;
    if (c <= stop || trendReversed) {
      orders.push({
        side: "sell",
        client_id: `sell-${msg.seq}`,
        symbol: helloInfo.symbol,
        qty: posQty.toString(),
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      });
      outstanding = true;
    }
    return orders;
  }

  // Flat: look for a fresh-high breakout with the trend behind it.
  if (barsSeen >= LAST_ENTRY_BAR) return orders;
  if (barsSeen < coolUntilBar) return orders;
  if (recentHighs.length < DONCHIAN_BARS) return orders;

  const trendUp = emaFast > emaSlow && c > emaSlow;
  const breakout = c > prevDonchianHigh;
  if (!trendUp || !breakout) return orders;

  const notional = (cash * BigInt(SIZE_NUM)) / BigInt(SIZE_DEN);
  if (notional < helloInfo.minNotional) return orders;
  if (notional < 1000000n) return orders; // at least 1 USDC

  orders.push({
    side: "buy",
    client_id: `buy-${msg.seq}`,
    symbol: helloInfo.symbol,
    notional_quote_units: notional.toString(),
    max_slippage_bps: MAX_SLIPPAGE_BPS,
  });
  outstanding = true;
  return orders;
}

// ------------------------------------------------------------------
// Main loop: read NDJSON lines, answer every batch with one reply.
// ------------------------------------------------------------------
function onHello(msg: any): void {
  const sym = msg.symbols && msg.symbols[0];
  helloInfo = {
    symbol: sym ? sym.symbol : "CBBTC",
    warmupBars: typeof msg.warmup_bars === "number" ? msg.warmup_bars : 0,
    minNotional: BigInt(
      (msg.fees && msg.fees.min_notional_quote_units) || "1000000",
    ),
  };
}

function sendReply(seq: number, orders: any[]): void {
  process.stdout.write(
    JSON.stringify({ type: "reply", seq, orders }) + "\n",
  );
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line: string) => {
  const trimmed = line.trim();
  if (trimmed === "") return;
  let msg: any;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (msg.type === "hello") {
    onHello(msg);
  } else if (msg.type === "batch") {
    const orders = decide(msg);
    sendReply(msg.seq, orders);
  } else if (msg.type === "done") {
    process.exit(0);
  }
});
