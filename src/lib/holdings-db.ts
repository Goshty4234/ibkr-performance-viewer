import type { HoldingDay, HoldingsData, HoldingSymbol, HoldingTrade } from './ibkr-flex-holdings';

export interface DbHoldings extends HoldingsData {
  id: string;
  portfolioAccountId: string;
  baseCurrency: string;
  periodStart: string;
  periodEnd: string;
  imported_at: string;
}

/** Accepts snake_case (Supabase row) or camelCase (already mapped API JSON). */
export function dbToHoldings(row: Record<string, unknown>): DbHoldings {
  const days = (row.days as HoldingDay[]) ?? [];
  return {
    id: row.id as string,
    portfolioAccountId: (row.portfolio_account_id ?? row.portfolioAccountId) as string,
    baseCurrency: ((row.base_currency ?? row.baseCurrency) as string) ?? 'CAD',
    periodStart: (row.period_start ?? row.periodStart ?? days[0]?.date ?? '') as string,
    periodEnd: (row.period_end ?? row.periodEnd ?? days[days.length - 1]?.date ?? '') as string,
    symbols: (row.symbols as HoldingSymbol[]) ?? [],
    days,
    trades: (row.trades as HoldingTrade[]) ?? [],
    imported_at: (row.imported_at ?? row.importedAt) as string,
  };
}

/**
 * Merges a new import into what is stored. The incoming days replace the stored days with the same
 * date, and the trades of the period the import covers are replaced too (importing the same file twice
 * changes nothing). Symbol indexes of the incoming file are remapped onto the stored symbol table.
 */
export function mergeHoldings(existing: HoldingsData | null, incoming: HoldingsData): HoldingsData {
  const symbols: HoldingSymbol[] = existing ? [...existing.symbols] : [];
  const index = new Map(symbols.map((s, i) => [`${s.assetClass}|${s.symbol}`, i]));
  const remap = incoming.symbols.map((s) => {
    const key = `${s.assetClass}|${s.symbol}`;
    let i = index.get(key);
    if (i === undefined) {
      i = symbols.length;
      symbols.push(s);
      index.set(key, i);
    }
    return i;
  });

  const days = new Map<string, HoldingDay>();
  for (const d of existing?.days ?? []) days.set(d.date, d);
  for (const d of incoming.days) {
    days.set(d.date, { date: d.date, positions: d.positions.map((p) => ({ ...p, s: remap[p.s] })) });
  }

  const start = incoming.days[0]?.date ?? incoming.trades[0]?.date ?? '';
  const end = incoming.days[incoming.days.length - 1]?.date ?? incoming.trades[incoming.trades.length - 1]?.date ?? '';
  const keptTrades = (existing?.trades ?? []).filter((t) => !start || t.date < start || t.date > end);
  const trades = [...keptTrades, ...incoming.trades].sort((a, b) =>
    (a.date + a.time).localeCompare(b.date + b.time),
  );

  return {
    symbols,
    days: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)),
    trades,
  };
}
