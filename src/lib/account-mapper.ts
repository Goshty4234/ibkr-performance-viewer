import type { PortfolioAccount } from './types';

export const PENDING_IBKR_PREFIX = 'pending:';

export function isPendingIbkrId(id: string | undefined | null): boolean {
  return Boolean(id?.startsWith(PENDING_IBKR_PREFIX));
}

export function formatIbkrIdDisplay(id: string | undefined | null): string {
  if (!id || isPendingIbkrId(id)) return 'Détecté au 1er CSV';
  return id;
}

/** Accepts snake_case (Supabase row) or camelCase (already mapped API JSON). */
export function dbToAccount(row: Record<string, unknown>): PortfolioAccount {
  return {
    id: row.id as string,
    user_id: (row.user_id ?? row.userId) as string,
    ibkrAccountId: (row.ibkr_account_id ?? row.ibkrAccountId) as string,
    displayName: (row.display_name ?? row.displayName) as string,
    notes: ((row.notes as string) ?? '') || '',
    created_at: (row.created_at ?? row.createdAt) as string,
    updated_at: (row.updated_at ?? row.updatedAt) as string,
    statementCount:
      row.statement_count != null
        ? Number(row.statement_count)
        : row.statementCount != null
          ? Number(row.statementCount)
          : undefined,
  };
}
