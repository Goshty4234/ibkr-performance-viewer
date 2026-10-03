'use client';

import { useCallback, useEffect, useState } from 'react';
import type { LocalUsage } from '@/lib/engine/client';
import { useEngineStore } from '@/lib/engine/store';
import { localClient } from '@/lib/storage/local-library';
import { fmtBytes, fmtPct, pct } from '@/lib/storage/format';
import { getResultSource, type ResultSource, setResultSource, useStorageProfile } from '@/lib/storage/profile';
import { purgeMyOnlineResults } from '@/lib/storage/purge';
import EngineUpdate from '../backtest/EngineUpdate';
import Meter from './Meter';
import styles from './Storage.module.css';

type Msg = { kind: 'ok' | 'err' | 'info'; text: string } | null;

const CLEAN_CHOICES = [
  { v: 0, label: 'Jamais' },
  { v: 7, label: '7 jours' },
  { v: 14, label: '14 jours' },
  { v: 30, label: '30 jours' },
  { v: 60, label: '60 jours' },
  { v: 90, label: '90 jours' },
  { v: 180, label: '180 jours' },
];

export default function StoragePanel() {
  const { init, status, engine } = useEngineStore();
  const { profile, loaded, refresh } = useStorageProfile();
  const [usage, setUsage] = useState<LocalUsage | null>(null);
  const [usageErr, setUsageErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<Msg>(null);
  const [days, setDays] = useState(30);
  const [source, setSource] = useState<ResultSource>('auto');

  useEffect(() => { init(); void refresh(); }, [init, refresh]);
  useEffect(() => { setSource(getResultSource(profile)); }, [profile]);

  const hasLibrary = status === 'ready' && engine?.kind === 'local' && !!engine.health.library;

  const loadUsage = useCallback(async () => {
    const c = localClient();
    if (!c) { setUsage(null); return; }
    try {
      setUsage(await c.storageUsage());
      setUsageErr(null);
    } catch (e) {
      setUsageErr(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => { if (hasLibrary) void loadUsage(); else setUsage(null); }, [hasLibrary, loadUsage]);

  async function run(key: string, fn: () => Promise<string>) {
    setBusy(key);
    setMsg(null);
    try {
      setMsg({ kind: 'ok', text: await fn() });
    } catch (e) {
      setMsg({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
      void loadUsage();
      void refresh();
    }
  }

  const uid = profile?.userId ?? null;
  const freed = (r: { removed: number; freed: number }) => `${r.removed} élément(s) supprimé(s), ${fmtBytes(r.freed)} libérés.`;

  function localPurge(target: 'runs' | 'ibkr' | 'cache' | 'prices', older: number | null, confirmText: string) {
    const c = localClient();
    if (!c || !confirm(confirmText)) return;
    void run(`l-${target}`, async () => freed(await c.storagePurge({ target, older_than_days: older, keep_pinned: true, user: target === 'cache' || target === 'prices' ? null : uid })));
  }

  async function saveSettings(patch: { auto_clean_days?: number; keep_pinned?: boolean }) {
    const c = localClient();
    if (!c) return;
    try {
      const s = await c.setStorageSettings(patch);
      setUsage((u) => (u ? { ...u, settings: s } : u));
    } catch (e) {
      setMsg({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
    }
  }

  const canChooseSource = !!profile && (profile.tier === 'full' || profile.isAdmin);
  const total = usage?.total ?? 0;
  const diskFree = usage?.disk.free ?? null;
  const folderShare = diskFree !== null ? pct(total, total + diskFree) : 0;

  return (
    <div className={styles.page}>
      <div className={styles.pageHeader}>
        <h1>Stockage</h1>
        <p>
          Tes résultats lourds vivent dans le dossier du moteur sur ton PC ; seules les configurations et les fiches légères sont
          en ligne. Ici tu vois ce que chacun occupe et tu peux faire le ménage.
        </p>
      </div>

      {msg && <p className={`${styles.note} ${msg.kind === 'ok' ? styles.noteOk : msg.kind === 'err' ? styles.noteErr : ''}`}>{msg.text}</p>}

      <div className={styles.grid}>
        <section className={`card ${styles.section}`}>
          <h2 className={styles.sectionTitle}>Sur ce PC · dossier du moteur</h2>
          {!hasLibrary && (
            <p className={`${styles.note} ${styles.noteWarn}`} style={{ marginTop: 0 }}>
              {status === 'detecting' || status === 'idle'
                ? 'Détection du moteur…'
                : status === 'ready' && engine?.kind === 'local'
                  ? 'Ton moteur est trop ancien pour gérer le dossier de stockage : mets-le à jour avec le bouton ci-dessous.'
                  : 'Aucun moteur local détecté. Lance le moteur pour voir et gérer le dossier. En attendant, tes résultats ne sont conservés qu’en ligne, selon ton niveau.'}
            </p>
          )}
          {!hasLibrary && status === 'ready' && engine?.kind === 'local' && <EngineUpdate />}
          {hasLibrary && usageErr && <p className={`${styles.note} ${styles.noteErr}`}>{usageErr}</p>}
          {hasLibrary && usage && (
            <>
              <div className={styles.bigNumber}>
                {fmtBytes(total)}
                {diskFree !== null && <small>{fmtPct(folderShare)} du disque (dossier + espace libre)</small>}
              </div>
              <Meter used={total} total={diskFree !== null ? total + diskFree : null} />
              <div className={styles.meterRow}>
                <span>{usage.folders.reduce((n, f) => n + f.files, 0).toLocaleString('fr-CA')} fichiers</span>
                <span>{diskFree !== null ? `${fmtBytes(diskFree)} libres sur le disque` : ''}</span>
              </div>
              <p className={`${styles.fold}`} style={{ marginTop: '0.5rem' }}>{usage.home}</p>
              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <thead><tr><th>Dossier</th><th className={styles.num}>Taille</th><th className={styles.num}>Part</th></tr></thead>
                  <tbody>
                    {usage.folders.map((f) => (
                      <tr key={f.name}>
                        <td><div className={styles.cellMain}>{f.label}</div><div className={styles.faint}>{f.name}\ · {f.files.toLocaleString('fr-CA')} fichiers</div></td>
                        <td className={styles.num}>{fmtBytes(f.bytes)}</td>
                        <td className={styles.num}>{fmtPct(pct(f.bytes, total))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <h2 className={styles.sectionTitle} style={{ marginTop: '1.4rem' }}>Nettoyage automatique</h2>
              <div className={styles.fieldRow}>
                <label className={styles.field}>
                  Supprimer mes runs de plus de
                  <select
                    value={usage.settings.auto_clean_days}
                    onChange={(e) => void saveSettings({ auto_clean_days: Number(e.target.value) })}
                  >
                    {!CLEAN_CHOICES.some((c) => c.v === usage.settings.auto_clean_days) && (
                      <option value={usage.settings.auto_clean_days}>{usage.settings.auto_clean_days} jours</option>
                    )}
                    {CLEAN_CHOICES.map((c) => <option key={c.v} value={c.v}>{c.label}</option>)}
                  </select>
                </label>
                <label className={styles.check}>
                  <input type="checkbox" checked={usage.settings.keep_pinned} onChange={(e) => void saveSettings({ keep_pinned: e.target.checked })} />
                  Garder les runs protégés
                </label>
              </div>
              <p className={styles.faint} style={{ marginTop: '0.5rem' }}>
                Le moteur nettoie tout seul, au démarrage puis toutes les 6 heures, tant qu’il tourne.
              </p>

              <h2 className={styles.sectionTitle} style={{ marginTop: '1.4rem' }}>Faire de la place maintenant</h2>
              <div className={styles.fieldRow}>
                <label className={styles.field}>
                  Runs de plus de (jours)
                  <input type="number" min={0} max={3650} value={days} onChange={(e) => setDays(Math.max(0, Math.floor(Number(e.target.value) || 0)))} />
                </label>
                <button type="button" className="btn btn-secondary btn-sm" disabled={!!busy || !uid}
                  onClick={() => localPurge('runs', days, `Supprimer de ce PC mes runs de plus de ${days} jour(s) ? Les runs protégés sont gardés.`)}>
                  {busy === 'l-runs' ? 'Suppression…' : 'Supprimer les vieux runs'}
                </button>
              </div>
              <div className={styles.actions}>
                <button type="button" className="btn btn-secondary btn-sm" disabled={!!busy}
                  onClick={() => localPurge('cache', null, 'Vider les résultats temporaires (cache de portfolios et fichiers de calcul récents) ? Aucun de tes runs enregistrés n’est touché.')}>
                  Vider le cache temporaire
                </button>
                <button type="button" className="btn btn-secondary btn-sm" disabled={!!busy}
                  onClick={() => localPurge('prices', null, 'Supprimer les prix de tickers en cache ? Ils se retéléchargent au besoin (le premier backtest sera plus long).')}>
                  Vider les prix en cache
                </button>
                <button type="button" className="btn btn-secondary btn-sm" disabled={!!busy || !uid}
                  onClick={() => localPurge('ibkr', null, 'Supprimer de ce PC les relevés IBKR (CSV) que tu as importés ? Tes données analysées en ligne ne sont pas touchées.')}>
                  Supprimer mes CSV IBKR
                </button>
                <button type="button" className="btn btn-danger btn-sm" disabled={!!busy || !uid}
                  onClick={() => localPurge('runs', null, 'Supprimer de ce PC tous mes runs non protégés ?')}>
                  Supprimer tous mes runs locaux
                </button>
              </div>
            </>
          )}
        </section>

        <section className={`card ${styles.section}`}>
          <h2 className={styles.sectionTitle}>
            En ligne · Supabase
            {profile && (
              <>
                <span className={`${styles.badge} ${profile.tier === 'full' ? styles.badgeFull : styles.badgeLean}`}>
                  {profile.tier === 'full' ? 'Complet' : 'Léger'}
                </span>
                {profile.isAdmin && <span className={`${styles.badge} ${styles.badgeAdmin}`}>Admin</span>}
              </>
            )}
          </h2>
          {!loaded && <p className={styles.muted}>Chargement…</p>}
          {loaded && !profile && <p className={styles.muted}>Mode invité : rien n’est conservé en ligne.</p>}
          {profile && (
            <>
              <div className={styles.bigNumber}>
                {fmtBytes(profile.usedBytes)}
                <small>
                  {profile.quotaBytes === null ? 'de résultats — aucune limite' : `sur ${fmtBytes(profile.quotaBytes)} (${fmtPct(pct(profile.usedBytes, profile.quotaBytes))})`}
                </small>
              </div>
              {profile.quotaBytes !== null && <Meter used={profile.usedBytes} total={profile.quotaBytes} />}
              <div className={styles.meterRow}>
                <span>{profile.runs} run(s) · {profile.configs} configuration(s)</span>
                <span>Fiches et configurations : {fmtBytes(profile.dbBytes)}</span>
              </div>
              <p className={styles.note}>
                {profile.tier === 'full'
                  ? 'Niveau Complet : tous tes résultats sont aussi conservés en ligne, tu peux les ouvrir depuis n’importe quel appareil sans moteur.'
                  : 'Niveau Léger : tes configurations et les résultats légers sont en ligne. Un résultat lourd reste dans ton dossier ; sur un autre appareil il s’affiche en résumé et se récupère en relançant le run.'}
                {!profile.managed && ' (Les règles d’administration ne sont pas encore actives côté serveur : valeurs par défaut.)'}
              </p>

              {canChooseSource && (
                <div className={styles.fieldRow}>
                  <label className={styles.field}>
                    Lire mes résultats depuis
                    <select
                      value={source}
                      onChange={(e) => { const v = e.target.value as ResultSource; setSource(v); setResultSource(v); }}
                    >
                      <option value="auto">Automatique — le dossier d’abord, sinon Supabase</option>
                      <option value="local">Le dossier uniquement</option>
                      <option value="cloud">Supabase uniquement</option>
                    </select>
                  </label>
                </div>
              )}
              {canChooseSource && source !== 'auto' && (
                <p className={styles.faint} style={{ marginTop: '0.4rem' }}>
                  Réglage de cet appareil, utile pour comparer les deux sources. Un run absent de la source choisie s’affichera comme indisponible.
                </p>
              )}

              <h2 className={styles.sectionTitle} style={{ marginTop: '1.4rem' }}>Faire de la place en ligne</h2>
              <p className={styles.muted}>
                Supprime seulement les fichiers de résultats en ligne. Tes configurations, tes fiches de runs et ton dossier local restent intacts.
                Les runs non protégés de plus de 30 jours sont de toute façon retirés automatiquement.
              </p>
              <div className={styles.actions}>
                <button type="button" className="btn btn-secondary btn-sm" disabled={!!busy}
                  onClick={() => confirm('Supprimer en ligne les résultats de plus de 30 jours (runs protégés gardés) ?') && void run('c-old', async () => `${(await purgeMyOnlineResults({ olderThanDays: 30 })).runs} run(s) allégé(s) en ligne.`)}>
                  {busy === 'c-old' ? 'Suppression…' : 'Résultats en ligne > 30 jours'}
                </button>
                <button type="button" className="btn btn-danger btn-sm" disabled={!!busy}
                  onClick={() => confirm('Supprimer en ligne TOUS mes résultats non protégés ? (Configurations, fiches et dossier local intacts.)') && void run('c-all', async () => `${(await purgeMyOnlineResults()).runs} run(s) allégé(s) en ligne.`)}>
                  {busy === 'c-all' ? 'Suppression…' : 'Vider mes résultats en ligne'}
                </button>
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
