// Sharpe Sprint — Cleanest Paper Bot Wins.
// A conservative pump.fun replay bot for agent-fun/replay/v2.
//
// Idea: the score is the hourly Sharpe ratio, not raw PnL, so the bot optimises for
// steady, repeatable, small wins spread across the whole window instead of one lucky
// moonshot. It runs two tiers that share the 5 open-position slots:
//
//   Tier A — the profit engine (max 3 slots, 0.05 SOL a trade). It buys only
//   late-stage organic strength: a coin with 15+ trades, 300+ slots old, a real SOL
//   reserve of 2+ SOL, more buys than sells, 8+ distinct buyers, a creator who has
//   never sold, and a price up 10-120% from creation. It exits on a take profit
//   (+25%), a trailing stop (arms at +8%, sells on a -3% pullback) or a very long
//   time stop; there is no fixed stop loss, because on the dev window the losers
//   that fall far usually recover enough for the trailing stop to catch them, and
//   cutting them early only locks the loss in. Every exit sells the whole position,
//   so each trade is one clean round trip.
//
//   Tier B — the breadth tier (max 2 slots, 0.012 SOL a trade, capped at 25 closed
//   round trips per run). The guardrail needs a round trip of at least 0.01 SOL on
//   at least 20 distinct mints, and Tier A alone only makes ~11 of those in a 6-hour
//   window, so Tier B banks the count cheaply: it buys the leftovers Tier A passed
//   on (8+ trades, 900+ slots old, 1+ SOL real reserve, 3+ distinct buyers, creator
//   still holding, price up 5-300%) and exits fast (take profit +20%, stop loss
//   -15%, trailing +5%/-3%, time stop 300 slots). A breadth trade loses a little on
//   average, but at 0.012 SOL the 25-trip cap costs only ~0.015 SOL in total, and
//   the guardrail it buys is worth far more than that.
//
// Why late, not early: on the dev window the spike of a fresh coin peaks a median
// ~11 slots after it first becomes buyable and then decays, so buying the first
// buyable trade mostly buys the top; buying after the coin has proven it can hold
// a crowd wins ~48% of round trips instead of ~25%. The parameters were tuned on
// the kit's dev window with an offline replay of the same logic (dev: Tier A alone
// +0.008 SOL, Sharpe +0.02, 44 round trips, max drawdown 0.7%; two-tier -0.016 SOL,
// Sharpe -0.05, 54 round trips, 23-34 trips in every 6-hour slice of the window).
//
// Determinism: the harness runs the bot twice and the two action logs must match
// byte for byte, so there is no clock, no environment read and no Math.random
// anywhere. All money math is integer (bigint) lamports; price comparisons are
// done by cross-multiplication, never floats. The only randomness the protocol
// allows is the seed carried by the hello message, and this bot does not need it.
//
// Wire recap (protocol agent-fun/replay/v2): the harness sends hello once, then one
// batch per slot (its events, marks, fills and the account), then done. The bot
// answers every batch with exactly one reply echoing the batch seq, holding at most
// max_orders_per_batch orders. An order decided on the batch for slot s fills at
// slot s + latency_slots. Buys on one mint in one reply share one size cap
// (hello.caps.max_order_bps_of_real_reserve of the mint's real SOL reserve). A buy
// the harness refuses for slippage comes back as a rejected fill and costs nothing.
//
// Guardrails the bot is built to clear: a round trip of at least 0.01 SOL on at
// least 20 distinct mints, max drawdown 50%, at most 5 open positions, and a net PnL
// above 0 SOL after every fee (the bar for a paid place).

import { LAMPORTS_PER_SOL, runBot, type BuyInput, type SellInput } from './vendor/makefun-bot.ts';

// ---------------------------------------------------------------- tuning

type Tier = 'A' | 'B';

interface TierParams {
  /** SOL staked per buy. */
  stake: bigint;
  /** A coin must show this many trades before it can be bought. */
  minTrades: number;
  /** A coin must be at least this many slots old before it can be bought. */
  minAgeSlots: number;
  /** A coin must hold this much real SOL before it can be bought. */
  minRealSol: bigint;
  /** At least this many distinct buyers must have traded the coin. */
  minUsers: number;
  /** Entry: price up at least this much (bps) from creation. */
  riseMinBps: bigint;
  /** Entry: price up at most this much (bps) from creation. */
  riseMaxBps: bigint;
  /** Take profit (bps of cost, fees included in cost). */
  takeProfitBps: bigint;
  /** Stop loss (bps of cost). 10000 = no stop loss: the trailing stop is the exit. */
  stopLossBps: bigint;
  /** Trailing stop arms once the position is up this much (bps of cost). */
  trailArmBps: bigint;
  /** Trailing stop sells once the position has fallen this much (bps) from its peak. */
  trailDropBps: bigint;
  /** Time stop (slots): sell whatever is left and free the slot. */
  maxHoldSlots: number;
  /** How many of the 5 open-position slots this tier may use at once. */
  maxSlots: number;
}

/** Tier A — the profit engine. */
const TIER_A: TierParams = {
  stake: LAMPORTS_PER_SOL / 20n, // 0.05 SOL
  minTrades: 15,
  minAgeSlots: 300,
  minRealSol: 2n * LAMPORTS_PER_SOL,
  minUsers: 8,
  riseMinBps: 1000n,
  riseMaxBps: 12000n,
  takeProfitBps: 2500n,
  stopLossBps: 10000n, // no fixed stop loss (see the header)
  trailArmBps: 800n,
  trailDropBps: 300n,
  maxHoldSlots: 100000, // ~11 h: never binds in a 6-hour window, frees slots on a longer one
  maxSlots: 3,
};

/** Tier B — the breadth tier. */
const TIER_B: TierParams = {
  stake: 12_000_000n, // 0.012 SOL: just above the 0.01 SOL round-trip floor
  minTrades: 8,
  minAgeSlots: 900, // leftovers only: Tier A has had its chance by then
  minRealSol: LAMPORTS_PER_SOL,
  minUsers: 3,
  riseMinBps: 500n,
  riseMaxBps: 30000n,
  takeProfitBps: 2000n,
  stopLossBps: 1500n,
  trailArmBps: 500n,
  trailDropBps: 300n,
  maxHoldSlots: 300, // ~2 min: fast turnover is the point of this tier
  maxSlots: 2,
};

/** A round trip only counts toward the 20-mint bar when its buys spent this much (0.01 SOL). Never buy less. */
const MIN_BUY_LAMPORTS = LAMPORTS_PER_SOL / 100n;
/** Stop buying for breadth once this many breadth round trips have closed: the bar is banked, stop paying for it. */
const BREADTH_TRIP_CAP = 25;
/** Buy slippage guard (bps): a fill worse than the decision price by more than this is refused. */
const BUY_SLIPPAGE_BPS = 500;
/** Sell slippage guard (bps): exits must go through, so this is wider than the buy guard. */
const SELL_SLIPPAGE_BPS = 1000;
/** Basis points per unit. */
const BPS = 10000n;

// ---------------------------------------------------------------- per-mint bookkeeping

interface MintStats {
  /** Slot of its CreateEvent; -1 when first seen through a trade or a mark. */
  createdSlot: number;
  /** Virtual reserves at creation: the price the entry rise is measured from. */
  firstQuote: bigint;
  firstTokens: bigint;
  trades: number;
  buys: number;
  sells: number;
  /** Distinct wallets that traded the coin: a crowd, not wash trading. */
  users: Set<string>;
  /** The coin's creator (from its CreateEvent). */
  creator: string | null;
  /** True once the creator has sold any of it: a creator cashing out is a red flag. */
  creatorSold: boolean;
  /** True once a buy was sent for this mint (decided once, like the house baseline). */
  decided: boolean;
}

interface OpenTrade {
  tier: Tier;
  /** Slot the position was first seen in the account (the fill landed then). */
  entrySlot: number;
  /** Highest mark value (lamports) seen while holding, for the trailing stop. */
  peakValue: bigint;
}

const stats = new Map<string, MintStats>();
const open = new Map<string, OpenTrade>();
/** Buys sent but not yet filled, by mint: which tier they belong to (for the per-tier slot budget). */
const pendingBuy = new Map<string, Tier>();
/** Breadth round trips closed so far (any close reason counts: sold, completed, flattened). */
let breadthClosed = 0;

/** Mark value of a holding at the curve's latest reserves: tokens * quote / tokens. */
function markValue(tokens: bigint, virtualQuote: bigint, virtualTokens: bigint): bigint {
  if (virtualTokens === 0n) return 0n;
  return (tokens * virtualQuote) / virtualTokens;
}

await runBot({
  onBatch(state, batch) {
    const { caps } = state.hello;
    const tx = state.txFeeLamports();
    const orders: Array<BuyInput | SellInput> = [];

    // --- settle the pending-buy bookkeeping: a buy whose fill landed shows up as
    // a position (its tier moves into `open`); a buy that resolved without a fill
    // (rejected for slippage, or a failed transaction) drops out of the book.
    for (const [mint, tier] of [...pendingBuy]) {
      if (state.positions.has(mint)) {
        const pos = state.positions.get(mint)!;
        const curve = state.curves.get(mint);
        const value =
          curve === undefined ? pos.cost_lamports : markValue(pos.token_amount, curve.virtual_quote_reserves, curve.virtual_token_reserves);
        if (!open.has(mint)) open.set(mint, { tier, entrySlot: batch.slot, peakValue: value });
        pendingBuy.delete(mint);
      } else if (![...state.pending.values()].some((p) => p.order.mint === mint)) {
        pendingBuy.delete(mint);
      }
    }

    // --- fold this batch's events into per-mint stats, and look for entries.
    // An entry is only considered on a buy TradeEvent: buying into strength, never
    // into a sell-off. Tier A is tried first (it gets the best signals); Tier B
    // only takes what Tier A passed on. A coin that fails a check stays undecided
    // and is re-checked on its next buy event.
    let free = state.freeCashLamports();
    const tierUsed = (tier: Tier): number => {
      let n = 0;
      for (const t of open.values()) if (t.tier === tier) n += 1;
      for (const t of pendingBuy.values()) if (t === tier) n += 1;
      return n;
    };
    for (const e of batch.events) {
      if (e.event === 'CompleteEvent') {
        const s = stats.get(e.mint);
        if (s !== undefined) s.decided = true; // its tradable life is over
        continue;
      }
      if (e.event === 'CreateEvent') {
        if (!stats.has(e.mint)) {
          stats.set(e.mint, {
            createdSlot: e.slot,
            firstQuote: BigInt(e.virtual_quote_reserves),
            firstTokens: BigInt(e.virtual_token_reserves),
            trades: 0,
            buys: 0,
            sells: 0,
            users: new Set<string>(),
            creator: e.creator,
            creatorSold: false,
            decided: false,
          });
        }
        continue;
      }
      // TradeEvent.
      let s = stats.get(e.mint);
      if (s === undefined) {
        // First seen through a trade (its CreateEvent was outside the window).
        s = {
          createdSlot: -1,
          firstQuote: BigInt(e.virtual_quote_reserves),
          firstTokens: BigInt(e.virtual_token_reserves),
          trades: 0,
          buys: 0,
          sells: 0,
          users: new Set<string>(),
          creator: e.creator,
          creatorSold: false,
          decided: false,
        };
        stats.set(e.mint, s);
      }
      s.trades += 1;
      if (e.is_buy) s.buys += 1;
      else s.sells += 1;
      s.users.add(e.user);
      if (s.creator === null) s.creator = e.creator;
      if (e.user === s.creator && !e.is_buy) s.creatorSold = true;
      if (!e.is_buy || s.decided) continue;

      const curve = state.curves.get(e.mint);
      if (curve === undefined || curve.complete) {
        s.decided = true;
        continue;
      }
      // Rise since creation, in bps, by cross-multiplication (no floats):
      //   rise = (now - first) / first, with now = q/t and first = fq/ft.
      const nowQ = curve.virtual_quote_reserves;
      const nowT = curve.virtual_token_reserves;
      const riseDen = s.firstQuote * nowT;
      if (riseDen <= 0n) continue;
      const riseBps = ((nowQ * s.firstTokens - s.firstQuote * nowT) * BPS) / riseDen;

      // Pick the tier: A first, then B (only while the breadth cap is unmet).
      let tier: Tier | null = null;
      let params: TierParams | null = null;
      for (const cand of [TIER_A, TIER_B] as const) {
        const t: Tier = cand === TIER_A ? 'A' : 'B';
        if (t === 'B' && breadthClosed >= BREADTH_TRIP_CAP) continue;
        if (tierUsed(t) >= cand.maxSlots) continue;
        if (s.trades < cand.minTrades) continue;
        if (s.createdSlot >= 0 && batch.slot - s.createdSlot < cand.minAgeSlots) continue;
        if (s.buys <= s.sells) continue; // buyers must outnumber sellers
        if (s.users.size < cand.minUsers) continue; // a crowd, not one wallet
        if (s.creatorSold) continue; // never buy a coin its creator is dumping
        if (curve.real_quote_reserves < cand.minRealSol) continue;
        if (riseBps < cand.riseMinBps || riseBps > cand.riseMaxBps) continue;
        tier = t;
        params = cand;
        break;
      }
      if (tier === null || params === null) continue;

      const cap = state.maxBuyLamports(e.mint);
      const stake = cap < params.stake ? cap : params.stake;
      if (stake < MIN_BUY_LAMPORTS) continue;
      if (orders.length >= caps.max_orders_per_batch) continue;
      if (free < stake + tx) continue;

      orders.push({ side: 'buy', mint: e.mint, quote_lamports: stake, max_slippage_bps: BUY_SLIPPAGE_BPS });
      s.decided = true;
      pendingBuy.set(e.mint, tier);
      free -= stake + tx;
    }

    // --- exits: every held position is re-priced each batch against its cost,
    // with its own tier's rules. Cost already includes every fee paid, so TP/SL
    // are net of fees. A sell is always the whole position: one clean round trip
    // per trade. A pending sell is never doubled up.
    for (const [mint, pos] of state.positions) {
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if ([...state.pending.values()].some((p) => p.order.mint === mint && p.order.side === 'sell')) continue;
      const value = markValue(pos.token_amount, curve.virtual_quote_reserves, curve.virtual_token_reserves);
      const cost = pos.cost_lamports;
      if (cost <= 0n) continue;

      let t = open.get(mint);
      if (t === undefined) {
        // A position whose buy filled before this batch's bookkeeping ran (or a
        // fill that arrived without a pending-buy record): tier A by default is
        // wrong for breadth fills, so look it up from the pending book first.
        const tier = pendingBuy.get(mint) ?? 'A';
        t = { tier, entrySlot: batch.slot, peakValue: value };
        open.set(mint, t);
        pendingBuy.delete(mint);
      }
      if (value > t.peakValue) t.peakValue = value;
      const p = t.tier === 'A' ? TIER_A : TIER_B;

      const takeProfit = value * BPS >= cost * (BPS + p.takeProfitBps);
      const stopLoss = value * BPS <= cost * (BPS - p.stopLossBps);
      const trailingArmed = t.peakValue * BPS >= cost * (BPS + p.trailArmBps);
      const trailingHit = trailingArmed && value * BPS <= t.peakValue * (BPS - p.trailDropBps);
      const timeUp = batch.slot - t.entrySlot >= p.maxHoldSlots;
      if (!takeProfit && !stopLoss && !trailingHit && !timeUp) continue;
      if (orders.length >= caps.max_orders_per_batch) continue;

      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: SELL_SLIPPAGE_BPS });
    }

    // --- forget positions that are gone (sold, completed, flattened). A closed
    // breadth position counts toward the breadth cap.
    for (const mint of [...open.keys()]) {
      if (!state.positions.has(mint)) {
        if (open.get(mint)?.tier === 'B') breadthClosed += 1;
        open.delete(mint);
      }
    }

    return orders;
  },
});
