'use client';

import { create } from 'zustand';
import { EngineClient, probeEngine, resolveEngine, type ResolvedEngine } from './client';
import {
  type EnginePrefs,
  loadLocalPrefs,
  loadRemotePrefs,
  normalizeUrl,
  saveLocalPrefs,
  saveRemotePrefs,
} from './prefs';

export type EngineStatus = 'idle' | 'detecting' | 'ready' | 'offline';

interface EngineState {
  prefs: EnginePrefs;
  status: EngineStatus;
  engine: ResolvedEngine | null;
  client: EngineClient | null;
  lastCheck: number;
  init: () => void;
  /** forceLocal: the user says an engine now runs on this PC (asks Chrome's permission once). */
  detect: (opts?: { quiet?: boolean; forceLocal?: boolean }) => Promise<ResolvedEngine | null>;
  setPrefs: (patch: Partial<EnginePrefs>) => Promise<void>;
  /** Re-reads /health of the current engine (live pool stats) without re-resolving. */
  refreshHealth: () => Promise<void>;
}

const READY_RECHECK_MS = 20_000;
const OFFLINE_RECHECK_MS = 5_000;

let started = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let inflight: Promise<ResolvedEngine | null> | null = null;

export const useEngineStore = create<EngineState>((set, get) => {
  function schedule() {
    if (timer) clearTimeout(timer);
    const delay = get().status === 'ready' ? READY_RECHECK_MS : OFFLINE_RECHECK_MS;
    timer = setTimeout(() => {
      if (document.visibilityState === 'visible') void get().detect({ quiet: true });
      else schedule();
    }, delay);
  }

  return {
    prefs: { mode: 'auto', cloudUrl: '', localUrl: 'http://127.0.0.1:8765' },
    status: 'idle',
    engine: null,
    client: null,
    lastCheck: 0,

    init() {
      if (started || typeof window === 'undefined') return;
      started = true;
      set({ prefs: loadLocalPrefs() });
      // The portable engine opens the site with ?engine=local once it is ready.
      const url = new URL(window.location.href);
      const fromEngine = url.searchParams.get('engine') === 'local';
      if (fromEngine) {
        url.searchParams.delete('engine');
        window.history.replaceState(window.history.state, '', url.toString());
      }
      void get().detect({ forceLocal: fromEngine });
      loadRemotePrefs()
        .then((remote) => {
          if (!remote) return;
          const cur = get().prefs;
          const merged: EnginePrefs = {
            ...cur,
            mode: remote.mode ?? cur.mode,
            cloudUrl: remote.cloudUrl !== undefined && remote.cloudUrl !== '' ? remote.cloudUrl : cur.cloudUrl,
          };
          if (merged.mode !== cur.mode || merged.cloudUrl !== cur.cloudUrl) {
            saveLocalPrefs(merged);
            set({ prefs: merged });
            void get().detect();
          }
        })
        .catch(() => {});
      window.addEventListener('focus', () => void get().detect({ quiet: true }));
    },

    async detect(opts) {
      if (inflight && !opts?.forceLocal) return inflight;
      if (inflight) await inflight.catch(() => null);
      if (!opts?.quiet || get().status === 'idle') set({ status: 'detecting' });
      inflight = (async () => {
        const engine = await resolveEngine(get().prefs, opts?.forceLocal);
        const prev = get().engine;
        const same = prev && engine && prev.url === engine.url;
        set({
          engine,
          status: engine ? 'ready' : 'offline',
          client: engine ? (same ? get().client : new EngineClient(engine.url, engine.health.auth_required)) : null,
          lastCheck: Date.now(),
        });
        return engine;
      })();
      try {
        return await inflight;
      } finally {
        inflight = null;
        schedule();
      }
    },

    async setPrefs(patch) {
      const next: EnginePrefs = { ...get().prefs, ...patch };
      if (patch.cloudUrl !== undefined) next.cloudUrl = normalizeUrl(patch.cloudUrl);
      saveLocalPrefs(next);
      set({ prefs: next });
      await get().detect();
      await saveRemotePrefs(next).catch(() => {});
    },

    async refreshHealth() {
      const engine = get().engine;
      if (!engine) return;
      const health = await probeEngine(engine.url, engine.kind === 'local' ? 1500 : 6000);
      if (get().engine?.url !== engine.url) return;
      if (health) set({ engine: { ...engine, health }, lastCheck: Date.now() });
      else void get().detect({ quiet: true });
    },
  };
});
