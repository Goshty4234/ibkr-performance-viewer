import { createHmac } from 'crypto';
import type { CashFlow, DbStatement, DbNavSeries, DbTwrSeries, PortfolioAccount } from './types';
import { isPendingIbkrId, LINKED_IBKR_PLACEHOLDER, PENDING_IBKR_PREFIX } from './account-mapper';

const HASH_PREFIX = 'h:';

/** Empreinte irréversible de l'ID IBKR (lien import ↔ compte, sans stocker l'ID en clair). */
export function hashIbkrAccountId(raw: string, userId: string): string {
  const normalized = raw.trim().toUpperCase();
  const digest = createHmac('sha256', userId).update(`ibkr:${normalized}`).digest('hex');
  return `${HASH_PREFIX}${digest}`;
}

export function isHashedIbkrId(id: string | null | undefined): boolean {
  return Boolean(id?.startsWith(HASH_PREFIX));
}

export function isLinkedIbkrAccount(id: string | null | undefined): boolean {
  return Boolean(id && !isPendingIbkrId(id));
}

/** Vérifie un ID CSV contre la valeur stockée (hash ou legacy en clair). */
export function matchesIbkrAccountId(
  csvAccountId: string,
  stored: string | null | undefined,
  userId: string,
): boolean {
  if (!stored || isPendingIbkrId(stored)) return false;
  const raw = csvAccountId.trim().toUpperCase();
  if (isHashedIbkrId(stored)) return stored === hashIbkrAccountId(raw, userId);
  return stored.trim().toUpperCase() === raw;
}

export function hashIbkrAccountIdForStorage(
  raw: string | null | undefined,
  userId: string,
): string | null {
  if (!raw?.trim() || isPendingIbkrId(raw)) return raw ?? null;
  if (isHashedIbkrId(raw)) return raw;
  return hashIbkrAccountId(raw, userId);
}

export function sanitizeImportLabel(
  kind: 'statement' | 'nav' | 'twr' | 'cash',
  periodStart?: string,
  periodEnd?: string,
): string {
  if (kind === 'statement' && periodStart && periodEnd) {
    return `import-${periodStart}_${periodEnd}`;
  }
  if (kind === 'nav') return `nav-import-${periodStart ?? 'data'}`;
  if (kind === 'twr') return `twr-import-${periodStart ?? 'data'}`;
  return 'cash-flows-import';
}

export function sanitizeCashFlows(flows: CashFlow[]): CashFlow[] {
  return flows.map((f) => ({
    date: f.date,
    amount: f.amount,
    description: '',
    isExternal: f.isExternal,
  }));
}

/** Ne jamais exposer l'ID IBKR au client — pending ou « lié » uniquement. */
export function maskAccountForClient(account: PortfolioAccount): PortfolioAccount {
  if (isPendingIbkrId(account.ibkrAccountId)) {
    return { ...account, ibkrAccountId: account.ibkrAccountId };
  }
  return { ...account, ibkrAccountId: LINKED_IBKR_PLACEHOLDER };
}

export function sanitizeStatementForStorage<T extends Record<string, unknown>>(
  body: T,
  userId: string,
): T & {
  accountId: string;
  accountAlias: string;
  filename: string;
  cashFlows: CashFlow[];
} {
  const periodStart = String(body.periodStart ?? '');
  const periodEnd = String(body.periodEnd ?? '');
  const rawId = body.accountId as string | undefined;
  return {
    ...body,
    accountId: rawId ? hashIbkrAccountId(rawId, userId) : '',
    accountAlias: '',
    filename: sanitizeImportLabel('statement', periodStart, periodEnd),
    cashFlows: sanitizeCashFlows((body.cashFlows as CashFlow[]) ?? []),
  };
}

export function sanitizeStatementForClient(stmt: DbStatement): DbStatement {
  const label = sanitizeImportLabel('statement', stmt.periodStart, stmt.periodEnd);
  return {
    ...stmt,
    accountId: '',
    accountAlias: '',
    filename: label,
    cashFlows: sanitizeCashFlows(stmt.cashFlows),
  };
}

export function sanitizeNavForClient(series: DbNavSeries): DbNavSeries {
  const start = series.points[0]?.date;
  const end = series.points[series.points.length - 1]?.date;
  return {
    ...series,
    accountId: '',
    accountAlias: '',
    filename: sanitizeImportLabel('nav', start, end),
    cashFlows: sanitizeCashFlows(series.cashFlows ?? []),
  };
}

export function sanitizeTwrForClient(series: DbTwrSeries): DbTwrSeries {
  return {
    ...series,
    accountId: '',
    accountAlias: '',
    filename: sanitizeImportLabel('twr', series.periodStart, series.periodEnd),
  };
}

export function formatStatementPeriod(stmt: Pick<DbStatement, 'periodStart' | 'periodEnd'>): string {
  return `${stmt.periodStart} → ${stmt.periodEnd}`;
}
