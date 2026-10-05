'use client';

import { create } from 'zustand';
import { EngineClient, LAUNCH_URL, probeEngine, resolveEngine, type ResolvedEngine } from './client';
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
  /** A known engine stopped answering (busy, restarting): kept, retried every second, not "offline" yet. */
  reconnecting: boolean;
  /** An engine update restart is running: the engine is expected to vanish for a while. */
  restarting: boolean;
  /** What the engine update is doing / has done, shown by the banner even after the engine vanished and came back. */
  updateNotice: { kind: 'busy' | 'done' | 'error'; text: string } | null;
  setUpdateNotice: (n: { kind: 'busy' | 'done' | 'error'; text: string } | null) => void;
  /** « Lancer le moteur » was clicked: the page waits for the engine to answer. */
  launching: boolean;
  /** The last launch ended without an engine (link not registered yet, or start refused). */
  launchFailed: boolean;
  /** Opens momentum-engine://start (the engine's own launcher, see portable.register_launch_link)
   * and waits for it. Also finds an engine started by hand. Must run inside the click handler. */
  launchLocal: () => Promise<boolean>;
  beginRestart: () => void;
  endRestart: () => void;
  init: () => void;
  /** forceLocal: the user says an engine now runs on this PC (asks Chrome's permission once). */
  detect: (opts?: { quiet?: boolean; forceLocal?: boolean }) => Promise<ResolvedEngine | null>;
  setPrefs: (patch: Partial<EnginePrefs>) => Promise<void>;
  /** Re-reads /health of the current engine (live pool stats) without re-resolving. */
  refreshHealth: () => Promise<void>;
}

const READY_RECHECK_MS = 20_000;
const OFFLINE_RECHECK_MS = 5_000;
/** An engine that answered before and goes quiet is retried this often... */
const RETRY_MS = 1_000;
/** ...for this long before the page concludes that no engine exists (an update restart waits longer). */
const LOST_GRACE_MS = 20_000;
/** First start (CA bundle, update check) can take a while; the window shows its progress. */
const LAUNCH_WAIT_MS = 60_000;
const LAUNCH_POLL_MS = 1_500;

let started = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let inflight: Promise<ResolvedEngine | null> | null = null;
let lostSince = 0;

export const useEngineStore = create<EngineState>((set, get) => {
  function schedule() {
    if (timer) clearTimeout(timer);
    const s = get();
    const delay = s.status === 'ready' ? READY_RECHECK_MS : s.reconnecting ? RETRY_MS : OFFLINE_RECHECK_MS;
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
    reconnecting: false,
    restarting: false,
    updateNotice: null,
    setUpdateNotice(n) {
      set({ updateNotice: n });
    },
    launching: false,
    launchFailed: false,

    async launchLocal() {
      if (get().launching) return false;
      set({ launching: true, launchFailed: false });
      // Unknown scheme (engine never started since this feature): the browser does nothing, and the
      // loop below still finds an engine started by hand.
      window.location.href = LAUNCH_URL;
      const t0 = Date.now();
      try {
        while (Date.now() - t0 < LAUNCH_WAIT_MS) {
          await new Promise((r) => setTimeout(r, LAUNCH_POLL_MS));
          if (get().status === 'ready') return true;
          if (await get().detect({ quiet: true, forceLocal: true })) return true;
        }
        set({ launchFailed: true });
        return false;
      } finally {
        set({ launching: false });
      }
    },

    beginRestart() {
      set({ restarting: true });
    },
    endRestart() {
      set({ restarting: false });
    },

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
        if (engine) {
          lostSince = 0;
          const same = !!prev && prev.url === engine.url;
          set({
            engine,
            status: 'ready',
            reconnecting: false,
            client: same ? get().client : new EngineClient(engine.url, engine.health.auth_required),
            lastCheck: Date.now(),
          });
          return engine;
        }
        // A background re-check of an engine that answered a moment ago: it is usually busy or
        // restarting (update). Keep it and retry quickly before saying that no engine exists.
        if (prev && opts?.quiet) {
          const now = Date.now();
          if (!lostSince) lostSince = now;
          if (get().restarting || now - lostSince < LOST_GRACE_MS) {
            set({ status: 'detecting', reconnecting: true, lastCheck: now });
            return null;
          }
        }
        lostSince = 0;
        set({ engine: null, client: null, status: 'offline', reconnecting: false, lastCheck: Date.now() });
        return null;
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
