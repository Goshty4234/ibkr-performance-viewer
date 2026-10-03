import { deleteRun, listRuns } from '@/lib/backtest/history';
import { getProfile } from './profile';

/**
 * A person's own online results (their local folder is cleaned separately, by the engine).
 * The run rows (configuration + statistics) stay listed: only the heavy files are removed, so
 * nothing needed to restore or re-run is lost. Pinned runs are kept unless `includePinned`.
 */
export async function purgeMyOnlineResults(opts: { olderThanDays?: number | null; includePinned?: boolean } = {}): Promise<{ runs: number }> {
  const rows = await listRuns(1000);
  const cutoff = opts.olderThanDays != null ? Date.now() - opts.olderThanDays * 86_400_000 : null;
  let runs = 0;
  for (const r of rows) {
    if (!r.cloud || !r.result_path) continue;
    if (r.pinned && !opts.includePinned) continue;
    if (cutoff !== null && Date.parse(r.created_at) >= cutoff) continue;
    await deleteRun(r, { cloudOnly: true, keepRow: true });
    runs += 1;
  }
  void getProfile(0);
  return { runs };
}
