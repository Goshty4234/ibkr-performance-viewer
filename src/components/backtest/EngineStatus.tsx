'use client';

import { useEffect, useRef, useState } from 'react';
import type { EngineMode } from '@/lib/engine/prefs';
import { useEngineStore } from '@/lib/engine/store';
import styles from './EngineStatus.module.css';

const MODE_LABELS: Record<EngineMode, string> = { auto: 'Auto', local: 'Mon PC', cloud: 'En ligne' };

export default function EngineStatus() {
  const { status, engine, prefs, init, detect, setPrefs, refreshHealth, client } = useEngineStore();
  const [open, setOpen] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [cacheMsg, setCacheMsg] = useState<string | null>(null);
  const [cloudDraft, setCloudDraft] = useState('');
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => { init(); }, [init]);
  useEffect(() => {
    if (!open || status !== 'ready') return;
    void refreshHealth();
    const t = setInterval(() => void refreshHealth(), 2000);
    return () => clearInterval(t);
  }, [open, status, refreshHealth]);
  useEffect(() => { setCloudDraft(prefs.cloudUrl); }, [prefs.cloudUrl]);

  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  const label =
    status === 'ready' && engine
      ? engine.kind === 'local' ? 'Mon PC' : 'En ligne'
      : status === 'offline' ? 'Moteur hors ligne' : 'Détection…';
  const dotClass =
    status === 'ready' && engine
      ? engine.kind === 'local' ? styles.dotLocal : styles.dotCloud
      : status === 'offline' ? styles.dotOff : styles.dotWait;

  return (
    <div className={styles.wrap} ref={wrapRef}>
      <button type="button" className={styles.pill} onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className={`${styles.dot} ${dotClass}`} />
        <span className={styles.pillLabel}>{label}</span>
        {prefs.mode !== 'auto' && <span className={styles.pillMode}>{MODE_LABELS[prefs.mode]}</span>}
      </button>

      {open && (
        <div className={styles.pop} role="dialog" aria-label="Moteur de calcul">
          <div className={styles.popTitle}>Moteur de calcul</div>

          <div className={styles.segment} role="radiogroup">
            {(['auto', 'local', 'cloud'] as EngineMode[]).map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={prefs.mode === m}
                className={`${styles.segBtn} ${prefs.mode === m ? styles.segBtnActive : ''}`}
                onClick={() => void setPrefs({ mode: m })}
              >
                {MODE_LABELS[m]}
              </button>
            ))}
          </div>
          <p className={styles.hint}>
            {prefs.mode === 'auto' && 'Utilise ton PC quand le moteur local tourne, sinon le moteur en ligne.'}
            {prefs.mode === 'local' && 'Uniquement le moteur lancé sur ce PC.'}
            {prefs.mode === 'cloud' && 'Uniquement le moteur en ligne, même si ton PC est disponible.'}
          </p>

          {status === 'ready' && engine && (
            <div className={styles.info}>
              <div><span>Connecté à</span><b className="mono">{engine.url.replace(/^https?:\/\//, '')}</b></div>
              <div><span>Version</span><b className="mono">{engine.health.version}</b></div>
              <div><span>Processeurs</span><b className="mono">{engine.health.cpu_count ?? '?'}</b></div>
              <div>
                <span>Jobs</span>
                <b className="mono">
                  {engine.health.running}/{engine.health.max_jobs} en cours · {engine.health.queued} en attente
                </b>
              </div>
              {engine.health.max_workers != null && (
                <div>
                  <span>Processus de calcul</span>
                  <b className="mono">
                    {engine.health.workers_busy ?? 0} actifs / {engine.health.workers ?? 0} lancés (max {engine.health.max_workers})
                  </b>
                </div>
              )}
              {engine.health.tasks_queued != null && (
                <div>
                  <span>Tâches en file</span>
                  <b className="mono">{engine.health.tasks_queued}</b>
                </div>
              )}
              {engine.health.max_workers != null && (
                <div className={styles.poolBar} aria-hidden>
                  {Array.from({ length: engine.health.max_workers }, (_, i) => (
                    <span
                      key={i}
                      className={
                        i < (engine.health.workers_busy ?? 0) ? styles.poolBusy
                          : i < (engine.health.workers ?? 0) ? styles.poolIdle : styles.poolOff
                      }
                    />
                  ))}
                </div>
              )}
            </div>
          )}

          {status === 'offline' && (
            <div className={styles.offline}>
              {prefs.mode !== 'cloud' && (
                <p>
                  <b>Sur ton PC :</b> double-clique <code>Lancer le moteur.bat</code> à la racine du projet
                  (ou <code>python run_engine.py</code>). La page le détecte toute seule.
                </p>
              )}
              {prefs.mode !== 'local' && !prefs.cloudUrl && <p><b>En ligne :</b> aucune adresse configurée.</p>}
              {prefs.mode !== 'local' && prefs.cloudUrl && <p><b>En ligne :</b> {prefs.cloudUrl} ne répond pas.</p>}
            </div>
          )}

          {prefs.mode !== 'local' && (
            <form
              className={styles.cloudForm}
              onSubmit={(e) => {
                e.preventDefault();
                void setPrefs({ cloudUrl: cloudDraft });
              }}
            >
              <label htmlFor="engine-cloud-url">Adresse du moteur en ligne</label>
              <div className={styles.cloudRow}>
                <input
                  id="engine-cloud-url"
                  type="text"
                  value={cloudDraft}
                  placeholder="https://moteur.mondomaine.com"
                  onChange={(e) => setCloudDraft(e.target.value)}
                  spellCheck={false}
                />
                <button type="submit" className="btn btn-secondary btn-sm">OK</button>
              </div>
            </form>
          )}

          <button type="button" className={`btn btn-ghost btn-sm ${styles.retry}`} onClick={() => void detect()}>
            {status === 'detecting' ? 'Détection…' : 'Re-tester la connexion'}
          </button>
          {status === 'ready' && client && (
            <>
              <button
                type="button"
                className={`btn btn-ghost btn-sm ${styles.retry}`}
                disabled={clearing}
                title="Vide les données temporaires (market caps, PER, tickers introuvables, listes). La base de tickers est gardée : pour des prix frais, « Tout retélécharger » au lancement ou dans la section Tickers."
                onClick={async () => {
                  if (!confirm('Vider les données temporaires du moteur (market caps, PER, listes) ? La base de tickers est gardée.')) return;
                  setClearing(true);
                  setCacheMsg(null);
                  try {
                    const r = await client.clearCache();
                    setCacheMsg(`Cache vidé (${r.entries} entrées, ${r.pe} PER). Base de tickers gardée${r.kept !== undefined ? ` : ${r.kept} tickers` : ''}.`);
                  } catch (e) {
                    setCacheMsg(e instanceof Error ? e.message : String(e));
                  } finally {
                    setClearing(false);
                  }
                }}
              >
                {clearing ? 'Nettoyage…' : 'Vider le cache des données'}
              </button>
              {cacheMsg && <p className={styles.hint}>{cacheMsg}</p>}
            </>
          )}
        </div>
      )}
    </div>
  );
}
