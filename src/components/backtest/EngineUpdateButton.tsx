'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ENGINE_API, engineOutdated } from '@/lib/engine/client';
import { ENGINE_DOWNLOAD_URL } from '@/lib/engine/prefs';
import { useEngineStore } from '@/lib/engine/store';
import type { EngineHealth } from '@/lib/engine/types';

const POLL_MS = 1500;
const CHECK_LIMIT_MS = 20_000;
const DOWNLOAD_LIMIT_MS = 15 * 60_000;
const RESTART_LIMIT_MS = 120_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** True when this local engine predates the storage folder (no `library` in /health). */
export function engineStale(engine: { kind: string; health: EngineHealth } | null | undefined): boolean {
  return !!engine && engine.kind === 'local' && !engine.health.library;
}

/**
 * One smart button for the engine version. It looks at the engine's real state and shows only what
 * makes sense: up to date (with a manual re-check), a newer version being downloaded (with progress),
 * a version ready to install (one click: verify + restart, data kept), or a download link when the
 * engine is not the self-updating portable package. A portable engine is checked once when this
 * button first appears.
 */
export default function EngineUpdateButton() {
  const engine = useEngineStore((s) => s.engine);
  const client = useEngineStore((s) => s.client);
  const restarting = useEngineStore((s) => s.restarting);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const autoChecked = useRef(false);

  const health = engine?.health;
  const portable = !!health?.portable;
  const isLocal = engine?.kind === 'local';

  const fresh = useCallback(async (): Promise<EngineHealth | null> => {
    await useEngineStore.getState().refreshHealth();
    return useEngineStore.getState().engine?.health ?? null;
  }, []);

  /** Ask the engine to look for a release, then follow it until it settles. */
  const check = useCallback(async (): Promise<EngineHealth | null> => {
    if (!client) return null;
    setMsg('');
    setBusy('Recherche de mises à jour…');
    try {
      await client.updateCheck();
      const t0 = Date.now();
      let h: EngineHealth | null = null;
      while (Date.now() - t0 < DOWNLOAD_LIMIT_MS) {
        await sleep(POLL_MS);
        h = await fresh();
        const u = h?.update;
        if (!u) throw new Error('moteur injoignable');
        if (u.state === 'ready' || u.state === 'current') break;
        if (u.state === 'error') throw new Error(u.error || 'échec de la vérification');
        if (u.state === 'downloading') {
          setBusy(`Téléchargement${u.kind === 'runtime' ? ' (paquet complet)' : ''}… ${Math.round((u.progress ?? 0) * 100)} %`);
        } else if (u.state === 'verifying') {
          setBusy('Vérification de la nouvelle version…');
        } else if (Date.now() - t0 > CHECK_LIMIT_MS && (u.state === 'idle' || u.state === 'checking')) {
          throw new Error('pas de réponse du serveur de mises à jour');
        }
      }
      return h;
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setBusy('');
    }
  }, [client, fresh]);

  async function install() {
    if (!client) return;
    setMsg('');
    try {
      const target = useEngineStore.getState().engine?.health.update?.latest;
      setBusy('Redémarrage du moteur…');
      // While restarting, the page keeps the engine and shows "reconnecting" instead of "no engine".
      useEngineStore.getState().beginRestart();
      await client.updateApply();
      const t0 = Date.now();
      while (Date.now() - t0 < RESTART_LIMIT_MS) {
        await sleep(POLL_MS);
        const found = await useEngineStore.getState().detect({ quiet: true });
        if (found && (!target || found.health.version === target)) return;
      }
      throw new Error('le moteur n’a pas redémarré : regarde sa fenêtre, ou relance « Lancer le moteur »');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      useEngineStore.getState().endRestart();
      setBusy('');
    }
  }

  // Portable engine: look for a release once, the first time the button is shown.
  useEffect(() => {
    if (autoChecked.current || !client || !portable || !isLocal) return;
    const st = health?.update?.state;
    if (st === 'ready' || st === 'downloading' || st === 'verifying' || st === 'checking') return;
    autoChecked.current = true;
    void check();
  }, [client, portable, isLocal, health?.update?.state, check]);

  if (!engine || !health || !client) return null;
  if (!isLocal) {
    return <span style={{ color: 'var(--text-muted)' }}>Le moteur en ligne est mis à jour par son administrateur.</span>;
  }

  const u = health.update;
  const jobs = (health.running ?? 0) + (health.queued ?? 0);
  const stale = engineStale(engine);
  const outdated = engineOutdated(health);
  const note = msg ? <b style={{ color: 'var(--orange)' }}> {msg}</b> : null;

  const working = busy || (restarting ? 'Redémarrage du moteur…' : '');
  if (working) {
    return (
      <span style={{ display: 'inline-flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
        <button type="button" className="btn btn-secondary btn-sm" disabled>⟳ {working}</button>
      </span>
    );
  }

  // A newer version is downloaded and verified: one click installs it.
  if (u?.state === 'ready') {
    return (
      <span style={{ display: 'inline-flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={jobs > 0}
          title={jobs > 0 ? 'Attends la fin des backtests en cours' : 'Quelques secondes ; tes données sont conservées'}
          onClick={() => void install()}
        >
          ⟳ Installer la version {u.latest} et redémarrer
        </button>
        <span style={{ color: 'var(--text-muted)' }}>{jobs > 0 ? 'Attends la fin des backtests en cours.' : 'Tes données sont conservées.'}</span>
        {note}
      </span>
    );
  }

  // Not the self-updating package: either the engine is started from the sources (run_all.py), or it
  // is an old zip without the updater. The download is a full zip: a first install, not an update.
  if (!portable) {
    if (stale || outdated) {
      return (
        <span style={{ display: 'inline-flex', flexDirection: 'column', gap: '0.4rem' }}>
          <span style={{ color: 'var(--text-muted)' }}>
            Ce moteur ne se met pas à jour par un clic (il tourne depuis les sources, ou c’est une très ancienne version).
          </span>
          <span>
            <b>Si tu le lances avec run_all.py :</b> ferme-le et relance-le, il utilise déjà le nouveau code. Rien à télécharger.
          </span>
          <span>
            <b>Si tu utilises le zip :</b>{' '}
            <a href={ENGINE_DOWNLOAD_URL} download>télécharger la dernière version complète</a>, ferme l’ancien moteur,
            copie ton ancien dossier <code>data</code> dans le nouveau dossier, puis lance « Lancer le moteur ». Les prochaines
            mises à jour seront alors automatiques.
          </span>
        </span>
      );
    }
    return <span style={{ color: 'var(--text-muted)' }}>Version de développement (sources) : pas de mise à jour automatique.</span>;
  }

  // Portable engine, nothing to install right now.
  const noRelease = stale || (outdated && (u?.latest_api ?? 0) < ENGINE_API);
  return (
    <span style={{ display: 'inline-flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
      {noRelease ? (
        <span style={{ color: 'var(--orange)' }}>
          Aucune version plus récente n’est encore publiée pour ce site (après le git push, attends la fin du build GitHub).
        </span>
      ) : (
        <span style={{ color: 'var(--text-muted)' }}>✓ Moteur à jour ({health.version})</span>
      )}
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => void check()}>Rechercher</button>
      {note}
    </span>
  );
}
