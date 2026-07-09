import type { PortfolioAccount } from './types';

export const PENDING_IBKR_PREFIX = 'pending:';
export const LINKED_IBKR_PLACEHOLDER = `${PENDING_IBKR_PREFIX}linked`;

export function isPendingIbkrId(id: string | undefined | null): boolean {
  if (!id || id === LINKED_IBKR_PLACEHOLDER) return false;
  return id.startsWith(PENDING_IBKR_PREFIX);
}

export function isLinkedIbkrPlaceholder(id: string | undefined | null): boolean {
  return id === LINKED_IBKR_PLACEHOLDER;
}

export function formatIbkrIdDisplay(_id: string | undefined | null): string {
  return '';
}

export function formatAccountLinkLabel(id: string | undefined | null): string {
  if (isPendingIbkrId(id)) return 'En attente du 1er import';
  if (!id) return 'En attente du 1er import';
  return 'Lié';
}

/** Accepts snake_case (Supabase row) or camelCase (already mapped API JSON). */
export function dbToAccount(row: Record<string, unknown>): PortfolioAccount {
  return {
    id: row.id as string,
    user_id: (row.user_id ?? row.userId) as string,
    ibkrAccountId: (row.ibkr_account_id ?? row.ibkrAccountId) as string,
    displayName: (row.display_name ?? row.displayName) as string,
    notes: ((row.notes as string) ?? '') || '',
    analysisStartLock: (row.analysis_start_lock ?? row.analysisStartLock ?? null) as string | null,
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
