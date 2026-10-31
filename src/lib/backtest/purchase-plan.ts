/** Whole-share buy list. Each line is floored so the order cannot exceed its budget. */

export interface BuyInput {
  ticker: string;
  /** Target weight, fraction 0–1. */
  weight: number;
  price: number | null;
}

export interface BuyLine {
  ticker: string;
  weight: number;
  price: number | null;
  targetValue: number;
  shares: number;
  spent: number;
}

/**
 * `capFor` returns the maximum fraction of `amount` that ticker may reach, or
 * null when it has no cap. Cash is left as its own sleeve and is not spent on
 * extra shares.
 *
 * Filling walks one share at a time toward the name furthest below its target
 * that still fits in the leftover and under its cap. Rounding each line to the
 * nearest share can spend more than the cash on hand; flooring cannot.
 */
export function planPurchases(
  amount: number,
  positions: readonly BuyInput[],
  fill: boolean,
  capFor: (ticker: string) => number | null,
): BuyLine[] {
  const budget = Number.isFinite(amount) && amount > 0 ? amount : 0;
  const lines: BuyLine[] = positions
    .filter((p) => p.ticker !== 'CASH' && p.weight > 0)
    .map((p) => {
      const targetValue = budget * p.weight;
      const price = p.price != null && p.price > 0 ? p.price : null;
      const shares = price ? Math.floor(targetValue / price) : 0;
      return { ticker: p.ticker, weight: p.weight, price, targetValue, shares, spent: price ? shares * price : 0 };
    })
    .sort((a, b) => b.weight - a.weight || a.ticker.localeCompare(b.ticker));

  if (!fill || !(budget > 0)) return lines;

  let dust = 0;
  for (const line of lines) dust += line.targetValue - line.spent;
  let guard = 0;
  while (dust > 0 && guard < 100_000) {
    guard += 1;
    let best = -1;
    let bestGap = -Infinity;
    for (let i = 0; i < lines.length; i++) {
      const price = lines[i].price;
      if (price == null || dust < price) continue;
      const next = (lines[i].spent + price) / budget;
      const cap = capFor(lines[i].ticker);
      if (cap != null && next > cap + 1e-9) continue;
      const gap = lines[i].weight - lines[i].spent / budget;
      if (gap > bestGap) {
        bestGap = gap;
        best = i;
      }
    }
    if (best < 0) break;
    const price = lines[best].price as number;
    lines[best].shares += 1;
    lines[best].spent += price;
    dust -= price;
  }
  return lines;
}
