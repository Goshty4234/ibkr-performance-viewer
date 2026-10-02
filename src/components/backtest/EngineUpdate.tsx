'use client';

import { useState } from 'react';
import { ENGINE_API, engineOutdated } from '@/lib/engine/client';
import { ENGINE_DOWNLOAD_URL } from '@/lib/engine/prefs';
import { useEngineStore } from '@/lib/engine/store';
import type { EngineHealth } from '@/lib/engine/types';
import styles from './EngineSetup.module.css';

const POLL_MS = 1500;
const DOWNLOAD_LIMIT_MS = 15 * 60_000;
const RESTART_LIMIT_MS = 120_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Engine older than this site (runs refused) or a newer engine downloaded and waiting for a
 * restart. The portable engine updates itself: one click downloads, verifies and restarts it. */
export default function EngineUpdate() {
  const engine = useEngineStore((s) => s.engine);
  const client = useEngineStore((s) => s.client);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const health = engine?.health;
  if (!engine || !health || !client) return null;
  const outdated = engineOutdated(health);
  const update = health.update;
  if (!outdated && update?.state !== 'ready') return null;
  const jobs = (health.running ?? 0) + (health.queued ?? 0);

  async function fresh(): Promise<EngineHealth | null> {
    await useEngineStore.getState().refreshHealth();
    return useEngineStore.getState().engine?.health ?? null;
  }

  async function restartInto(target: string | undefined) {
    setBusy('Redémarrage du moteur…');
    await client!.updateApply();
    const t0 = Date.now();
    while (Date.now() - t0 < RESTART_LIMIT_MS) {
      await sleep(POLL_MS);
      const found = await useEngineStore.getState().detect({ quiet: true });
      if (found && (!target || found.health.version === target)) return;
    }
    throw new Error('le moteur n’a pas redémarré : regarde sa fenêtre, ou relance « Lancer le moteur »');
  }

  async function run() {
    setError('');
    try {
      let h: EngineHealth | null = health!;
      if (h.update?.state !== 'ready') {
        setBusy('Recherche de la nouvelle version…');
        await client!.updateCheck();
        const t0 = Date.now();
        while (Date.now() - t0 < DOWNLOAD_LIMIT_MS) {
          await sleep(POLL_MS);
          h = await fresh();
          const u = h?.update;
          if (!u) throw new Error('moteur injoignable');
          if (u.state === 'ready') break;
          if (u.state === 'error') throw new Error(u.error || 'échec de la mise à jour');
          if (u.state === 'current') {
            throw new Error(
              (u.latest_api ?? 0) < ENGINE_API
                ? 'la version du moteur pour ce site est en cours de publication : réessaie dans quelques minutes'
                : 'déjà à jour',
            );
          }
          if (u.state === 'downloading') {
            setBusy(`Téléchargement${u.kind === 'runtime' ? ' (paquet complet)' : ''}… ${Math.round((u.progress ?? 0) * 100)} %`);
          } else if (u.state === 'verifying') {
            setBusy('Vérification de la nouvelle version…');
          }
        }
        if (h?.update?.state !== 'ready') throw new Error('téléchargement trop long : réessaie plus tard');
      }
      await restartInto(h?.update?.latest);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  }

  if (!outdated) {
    return (
      <span className={styles.line} style={{ color: 'var(--text-muted)' }}>
        Nouvelle version du moteur prête ({update?.latest}).{' '}
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={!!busy || jobs > 0}
          title={jobs > 0 ? 'Attends la fin des backtests en cours' : 'Quelques secondes ; tes données sont conservées'}
          onClick={() => void run()}
        >
          {busy || 'Redémarrer pour l’installer'}
        </button>
        {error && <b style={{ color: 'var(--orange)' }}> {error}</b>}
      </span>
    );
  }

  return (
    <div className={styles.box}>
      <span className={styles.title}>Ton moteur ({health.version}) est trop ancien pour cette version du site.</span>
      {engine.kind === 'cloud' ? (
        <span className={styles.note}>Le moteur en ligne doit être mis à jour par son administrateur.</span>
      ) : health.portable ? (
        <span className={styles.steps}>
          <button type="button" className="btn btn-primary btn-sm" disabled={!!busy || jobs > 0} onClick={() => void run()}>
            {busy || '⟳ Mettre à jour le moteur'}
          </button>
          <span>
            {jobs > 0 ? 'Attends la fin des backtests en cours.' : 'Automatique : téléchargement, vérification, redémarrage. Tes données sont conservées.'}
          </span>
        </span>
      ) : (
        <span className={styles.steps}>
          <a className="btn btn-primary btn-sm" href={ENGINE_DOWNLOAD_URL} download>
            ⬇ Télécharger la nouvelle version
          </a>
          <span>ferme l’ancien moteur, décompresse et relance « Lancer le moteur » : ta base de tickers est conservée, et les prochaines mises à jour seront automatiques.</span>
        </span>
      )}
      {error && <span className={styles.note}><b>{error}</b></span>}
    </div>
  );
}
