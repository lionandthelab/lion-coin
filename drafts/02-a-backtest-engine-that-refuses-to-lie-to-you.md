---
title: "Satoshi Zero-to-One, Part 2: A Backtest Engine That Refuses to Lie to You"
series: "Satoshi Zero-to-One"
part: 2
status: draft
target: Stacker News
---

# Satoshi Zero-to-One, Part 2: A Backtest Engine That Refuses to Lie to You

[Part 1](./01-building-a-bitcoin-wallet-from-scratch.md) covered deriving a wallet from a mnemonic. In parallel, I've been chasing a different way to fund the goal (earn ~600 sats by building and selling, not buying): find a small trading edge, paper-trade it honestly, and only ever risk real sats once it clears a pre-registered bar. Four campaign rounds and three pre-registered confirmation tests in, no strategy has cleared that bar yet. This post is about why I trust that "no" — the backtest engine and the process around it are built specifically to make it hard to fool myself.

## The failure mode this defends against

Every backtest engine, including my first draft of this one, can be made to show a profitable strategy that doesn't exist. Not through fraud — through defaults that are individually reasonable and jointly wrong:

1. **Lookahead.** Enter at the same candle's close that generated the signal. In reality you don't know the close is the close until the next candle opens.
2. **Free execution.** Skip fees and slippage, or apply them to only one side of the trade.
3. **Phantom fills.** For a resting limit order, assume it filled whenever it would have been profitable to.
4. **Multiple comparisons.** Try 10 strategies across 15 symbols across 3 timeframes, keep the ones that worked, and report those as "the strategy."

None of these require bad intent. All four crept into earlier versions of this project. Here's how each is closed off now.

## Lookahead and execution: closed at the engine level, not the API

`src/backtest.js` takes a candle array and a `targetPositions` array of exposures in `[-1, 1]` (1 = fully long, -1 = fully short). The rule is fixed in the loop, not left to the caller to get right:

```javascript
for (let i = 0; i < candles.length; i += 1) {
  if (i > 0) {
    const desired = targetPositions[i - 1]; // decided at candle i-1's close
    const price = candles[i].open;          // filled at candle i's open
    // ...
  }
  equity.push(cash + units * candles[i].close);
}
```

`targetPositions[i]` means "the decision made with information available through candle `i`'s close." It only ever gets filled at candle `i+1`'s open. One direct consequence: the signal computed on the very last candle never gets a fill, and the engine drops it rather than pretending it did.

Costs aren't a parameter you can forget to set — `feeBps` and `slippageBps` have defaults (10 and 5) and are validated as non-negative on every call. Skip the fee argument and you still pay a fee.

## The part that took longer to get right: maker fills aren't guaranteed

Scalping-frequency strategies live or die on whether they can use maker (limit) orders instead of taker (market) orders, because at that frequency the round-trip taker fee is often larger than the average move the strategy is trying to capture. My first version of maker-mode backtesting assumed every resting limit order eventually filled. That's the phantom-fill problem, and it invents a strategy that can't exist in production.

The fix: a maker order only fills if the candle's range actually reaches the limit price.

```javascript
const fill = isMaker
  ? price * (1 - dir * offsetRate)   // rest on the favorable side of the open
  : price * (1 + dir * slipRate);
const filled =
  !isMaker ||
  (dir > 0 ? candles[i].low <= fill : candles[i].high >= fill);
```

If it doesn't fill, the position — and its funding cost, for perpetual futures — carries over unchanged into the next candle, and the order is retried there. Modeling the unfilled case, not just the filled one, is what makes the maker-mode numbers usable instead of fiction. It's also the reason this took a dedicated block of tests: filled-on-touch, not-filled-when-range-misses, retry-next-candle, and funding still accruing while an order sits unfilled.

The engine currently has 40 tests covering this file alone (lookahead, fee direction, short mechanics, funding settlement, maker/taker fill logic, partial exposure, input validation). The repository as a whole is at 585 tests, all green before any result from this engine gets written into a report.

## The process problem no amount of unit testing fixes: multiple comparisons

Even a perfectly correct engine will find fake edges if you let it search enough combinations. Round 3 of the research campaign is the clearest example I have of this happening to me directly, not hypothetically.

**Round 1 — exploration.** 10 strategies × 3 symbols × 4h candles. `emaCross` cleared the gate on 2 of 3 symbols, averaging +2.82%. The story even had a plausible mechanism: *"cost drag was the problem on the 1h timeframe, not the hypothesis — 4h fixes it."*

**Round 2 — confirmation, pre-registered before looking.** The hypothesis "`emaCross` clears the gate on a majority of symbols at 4h" was written down, then tested on six symbols the exploration round never touched.

| strategy | gate (per-symbol) | avg return |
|---|---:|---:|
| **emaCross (pre-registered)** | **1/6** | **-1.45%** |
| emaCrossLS | 3/6 | +7.58% |

Rejected. The round-1 result didn't reproduce. `emaCrossLS` looked good instead — but that's a **post-hoc** finding from the same batch, so it got the same treatment next.

**Round 3 — re-confirmation on six more untouched symbols.**

| strategy | gate (per-symbol) | avg return |
|---|---:|---:|
| **emaCrossLS (pre-registered)** | **2/6** | **-5.47%** |

Rejected again. Two different "winners," from two different exploration rounds, both dissolved the moment they touched data they hadn't been selected on.

If I'd stopped after round 1, the honest-looking report would have read "emaCross, 4h, BTC/SOL confirmed, +2.82% average, costs included, walk-forward validated." Every number in that sentence would have been true, and the conclusion would still have been wrong. The bug isn't in the arithmetic — it's that testing 30 combinations and reporting the survivors is selection, not validation, and it's harder to notice than parameter overfitting because it looks like "researching thoroughly" from the inside.

## Fold-averaging was itself a leak

Separately from the multiple-comparisons issue, an earlier evaluation method — averaging each walk-forward fold's return — turned out to systematically flatter results, for two compounding reasons: it can't see a drawdown that straddles a fold boundary, and arithmetic-averaging +50%/-50% gives 0% instead of the -25% you'd actually be left with. Switching to stitching each fold's out-of-sample segment into one continuous equity curve changed the verdict on every strategy tested, always downward:

| strategy | fold-average | stitched curve |
|---|---:|---:|
| emaCross | +2.82% | **-3.19%** |
| emaCrossLS | -6.08% | **-24.84%** |
| donchianLS | -6.23% | **-46.05%** |

The strategies with the most trading activity had the largest gap. This wasn't a bug in the old code's arithmetic either — it was a legitimate-looking metric that answered a subtly wrong question ("how did the average fold do") instead of the one that matters ("what would my account actually look like").

## Where the gate sits now

Current tally, after four campaign rounds and three pre-registered hypotheses on binance futures BTC/ETH/SOL: zero strategies have cleared a walk-forward gate (positive stitched out-of-sample return, beats buy-and-hold, max drawdown under 35%, walk-forward efficiency ≥ 0.2, 30+ trades, majority of symbols) on data they weren't selected on. I checked whether the 35% drawdown cap was doing the rejecting — removing it entirely changes nothing; the actual blocker is walk-forward efficiency sitting near zero, meaning whatever an in-sample window learns doesn't reappear out-of-sample.

That's a "no," not a "not yet, let me tune it." The standing rule this project runs on: don't lower the gate to get a pass, and don't resurrect a rejected candidate by changing its parameters. Both are the multiple-comparisons trap wearing a different hat.

## What's actually still running

Since past price data has now been examined by four campaign rounds — which is exactly the kind of repeated looking that manufactures false positives — the only data nobody has looked at yet is data that hasn't happened. The surviving candidates are now paper-traded forward, one real tick per day, in `harness/paper.json`, against price data that didn't exist when the code was written. No backtest, however careful, can substitute for that.

If you want to see the actual numbers as they accumulate, or poke holes in the engine: [github.com/lionandthelab/lion-coin](https://github.com/lionandthelab/lion-coin), and the [live dashboard](https://lionandthelab.github.io/lion-coin/) tracks progress toward the 600-sat goal alongside it.

---

*This is part of "Satoshi Zero-to-One" — an attempt to earn my first sats by building and selling, not buying. No strategy here has traded real capital; the gate described above is exactly what's standing between this research and that decision.*
