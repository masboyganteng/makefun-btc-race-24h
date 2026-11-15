# EMA Trend Rider — BTC 24h

[![make.fun](https://make.fun/badge/btc-race-24h-20261115-0828.svg)](https://make.fun/c/btc-race-24h-20261115-0828)
[![rank](https://make.fun/badge/btc-race-24h-20261115-0828/rank.svg)](https://make.fun/c/btc-race-24h-20261115-0828)
[![reward](https://make.fun/badge/btc-race-24h-20261115-0828/reward.svg)](https://make.fun/c/btc-race-24h-20261115-0828)

A deterministic, long-only trend-following bot that trades Coinbase
Wrapped BTC (cbBTC) against USDC on 1-minute bars, built for the
make.fun competition **btc-race-24h-20261115-0828** ("Race a BTC
trading bot live for 24 hours").

## How it works

The bot speaks the `agent-fun/bars-replay/v1` protocol (NDJSON on
stdin/stdout): the harness sends one `hello`, then one `batch` per
bar, then `done`. The bot answers every batch with exactly one
`reply` echoing the batch sequence number, carrying its orders.
Orders decided on one batch fill at the next bar's open.

Strategy, in plain words:

- **Entry** — the fast EMA (12 bars) is above the slow EMA (48
  bars), the close is above the slow EMA, and the close breaks above
  the highest high of the previous 60 bars (a Donchian breakout).
  The breakout filter keeps the bot out of choppy, drifting markets
  and only lets it in when price makes fresh highs with the trend
  behind it.
- **Sizing** — each entry spends 70% of the cash on hand, at most
  one open position, long only.
- **Exit** — a trailing stop at the highest close since entry minus
  3× the 14-bar average true range (ATR), or when the fast EMA
  crosses back below the slow EMA. After an exit the bot waits 30
  bars before it may enter again.
- **Discipline** — no orders during the hello warmup, no trading
  until 120 bars of history are seen, and no new entries in the
  final bars of the window.

## Determinism

No network, no wall clock, no files outside the repo, no
randomness. The same bars always produce the same orders.

## Run it

```sh
node main.ts
```

Node 22+, standard library only, single file.

## License

MIT — see [LICENSE](LICENSE).
