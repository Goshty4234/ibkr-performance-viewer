import { create } from 'zustand';
import { MC_DEFAULTS, mcJob, mcResult, type McJob, type McOptions, type McResult } from './montecarlo';
import type { EngineClient } from './client';

/** What the Monte Carlo page shows (settings, ticked portfolios, running job, result). Kept outside the component so
 * it survives the page being unmounted or rebuilt; the job keeps being followed even while another tab is open. */
export interface McSession {
  opt: McOptions;
  listText: string;
  selected: Set<string>;
  job: McJob | null;
  result: McResult | null;
  error: string | null;
}

export const useMcSession = create<McSession>(() => ({
  opt: MC_DEFAULTS,
  listText: '',
  selected: new Set<string>(),
  job: null,
  result: null,
  error: null,
}));

export type Update<T> = T | ((prev: T) => T);

export function setMc<K extends keyof McSession>(key: K, update: Update<McSession[K]>): void {
  useMcSession.setState((s) => ({ [key]: typeof update === 'function' ? (update as (p: McSession[K]) => McSession[K])(s[key]) : update }) as Pick<McSession, K>);
}

let poll: ReturnType<typeof setInterval> | null = null;

export function isFollowing(): boolean {
  return poll !== null;
}

function stop(): void {
  if (poll) clearInterval(poll);
  poll = null;
}

/** Polls a job until it ends, then fetches its result into the session. One at a time, whatever page is open. */
export function followJob(client: EngineClient, id: string): void {
  stop();
  poll = setInterval(async () => {
    try {
      const j = await mcJob(client, id);
      setMc('job', j);
      if (j.status === 'done') {
        stop();
        setMc('result', await mcResult(client, id));
      } else if (j.status === 'error' || j.status === 'cancelled') {
        stop();
        if (j.error) setMc('error', j.error);
      }
    } catch (e) {
      stop();
      setMc('error', e instanceof Error ? e.message : String(e));
    }
  }, 800);
}
