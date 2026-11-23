// cbbtc range-harvest bot for agent-fun/bars-replay/v1.
//
// Protocol: the harness sends one hello line, then one batch line per bar
// (one 1-minute CBBTC bar per batch), then done. This bot answers every
// batch with one reply echoing its seq and carrying its orders for that
// bar; orders decided on a batch fill at the next bar's open.
//
// Strategy (designed from the kit's dev bars, tuned by local grading):
//   * Default long: spend all cash on CBBTC on the first tradable batch
//     and stay invested. BTC's 1-minute noise is ~8 bps while a full
//     round trip costs ~26 bps, so frequent trading only pays fees.
//   * Range harvest: once 360 closes of history exist, track where the
//     latest close sits inside the trailing 360-bar close range
//     (range position 0 at the low, 1 at the high). When the close is
//     near the top of its range (>= 0.87) sell half the position,
//     keeping a core long. When the close falls back (range position
//     <= 0.28, or 0.5% below the trim price) spend all freed cash
//     buying back. The core keeps the trend upside; the harvested half
//     buys the pullbacks inside a sideways range.
//   * State is read from the account each batch (cash and position),
//     never assumed from past orders, so a rejected order simply
//     retries on the next bar. No full-exit guard: on the dev window
//     and on a trend-inverted copy of it, trend-exit rules whipsawed
//     and lost more than holding through.
//   * Deterministic: no clock, no network, no randomness, no file or
//     environment reads. Every decision is a pure function of the
//     closes seen so far plus the account the harness reports.

import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch } from './vendor/makefun-bars.ts';

// Trailing window (bars) for the close range.
const WINDOW = 360;
// Sell half when the close is this far up its trailing range.
const TRIM_AT = 0.87;
// Buy back when the close falls this far down its trailing range...
const REBUY_AT = 0.28;
// ...or this far below the close at which the trim was decided.
const REBUY_DROP = 0.005;
// Fraction of the position sold on a trim (1/2).
const TRIM_NUM = 1n;
const TRIM_DEN = 2n;
// A buy/sell is only sent when the move from the latest close could
// plausibly stay inside this many bps at the next open (the modelled
// slippage plus impact are ~10 bps; the largest open-vs-close move in
// the dev window was ~20 bps). 250 bps still blocks a gap fill.
const MAX_SLIPPAGE_BPS = 250;
// Minimum cash (in quote units, 1e6 = $1) worth deploying.
const MIN_CASH = 1_000_000n;

const closes: number[] = [];
let trimClose = 0;

function rangePosition(): number {
  const start = closes.length - WINDOW;
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = start; i < closes.length; i++) {
    const c = closes[i]!;
    if (c < lo) lo = c;
    if (c > hi) hi = c;
  }
  if (!(hi > lo)) return 0.5;
  return (closes[closes.length - 1]! - lo) / (hi - lo);
}

await runBars({
  onBatch(state: BarsState, batch: Batch) {
    const symbol = state.hello.symbols[0]!.symbol;
    for (const bar of batch.bars) {
      if (bar.symbol === symbol) closes.push(Number(bar.c));
    }
    // During warm-up batches trading is closed; only build history.
    if (state.warmingUp) return [];
    const held = state.positions.get(symbol);
    const qty = held === undefined ? 0n : held.qty;
    const cash = state.cash;
    const hasPosition = qty > 0n;
    const hasCash = cash >= MIN_CASH;
    // A recorded trim price is only meaningful while the trim's cash
    // is actually held. If the trim was rejected, cash is still dust
    // and the price must be cleared so the trim is retried.
    if (!hasCash) trimClose = 0;

    // Flat with cash: first tradable batch, or a buy that was
    // rejected earlier. Go all in.
    if (!hasPosition && hasCash) {
      return [{ side: 'buy', symbol, notional_quote_units: cash, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }
    if (!hasPosition) return [];
    const latest = closes[closes.length - 1]!;
    if (closes.length < WINDOW) return [];
    const rp = rangePosition();

    // Fully invested (only dust cash): trim half at the top of the range.
    if (!hasCash) {
      if (rp >= TRIM_AT) {
        trimClose = latest;
        const sellQty = (qty * TRIM_NUM) / TRIM_DEN;
        if (sellQty > 0n) {
          return [{ side: 'sell', symbol, qty: sellQty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
        }
      }
      return [];
    }
    // Cash held while holding a position: a trim is outstanding,
    // waiting for a pullback to buy back.
    if (trimClose > 0 && (rp <= REBUY_AT || latest <= trimClose * (1 - REBUY_DROP))) {
      trimClose = 0;
      return [{ side: 'buy', symbol, notional_quote_units: cash, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }
    return [];
  },
});
