'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  adminOverview,
  adminPurge,
  adminSetConfig,
  adminSetUserTier,
  MigrationMissing,
  type AdminOverview,
  type AdminUser,
  type PurgeReport,
  type PurgeScope,
} from '@/lib/storage/admin';
import { fmtAgo, fmtBytes, fmtPct, pct } from '@/lib/storage/format';
import Meter from './Meter';
import styles from './Storage.module.css';

type Msg = { kind: 'ok' | 'err'; text: string } | null;

const MB = 1_000_000;

const SCOPE_LABEL: Record<PurgeScope, string> = {
  old: 'les résultats de plus de N jours',
  results: 'tout l’historique de runs (garde configurations et IBKR)',
  all: 'TOUT (runs, configurations, données IBKR)',
};

function report(r: PurgeReport): string {
  return `${r.files} fichier(s), ${r.runs} run(s)${r.configs ? `, ${r.configs} configuration(s)` : ''}${r.accounts ? `, ${r.accounts} compte(s) IBKR` : ''} supprimé(s).`;
}

export default function AdminPanel({ selfId }: { selfId: string }) {
  const [ov, setOv] = useState<AdminOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<Msg>(null);
  const [days, setDays] = useState(30);
  const [includeSelf, setIncludeSelf] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setOv(await adminOverview());
      setError(null);
      setMissing(false);
    } catch (e) {
      setMissing(e instanceof MigrationMissing);
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function act(key: string, fn: () => Promise<string>) {
    setBusy(key);
    setMsg(null);
    setProgress(null);
    try {
      setMsg({ kind: 'ok', text: await fn() });
    } catch (e) {
      setMsg({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
      setProgress(null);
      await load();
    }
  }

  const users = ov?.users ?? [];
  const totalUserStorage = useMemo(() => users.reduce((n, u) => n + u.storage_bytes, 0), [users]);

  /** Several users one by one when the administrator is left out, a single call otherwise. */
  async function purge(scope: PurgeScope, only?: AdminUser): Promise<string> {
    const total: PurgeReport = { files: 0, runs: 0, configs: 0, accounts: 0 };
    const add = (r: PurgeReport) => { total.files += r.files; total.runs += r.runs; total.configs += r.configs; total.accounts += r.accounts; };
    const onProgress = (d: number, t: number) => setProgress(`${d}/${t} fichiers supprimés…`);
    if (only) add(await adminPurge(scope, { userId: only.id, days, onProgress }));
    else if (includeSelf) add(await adminPurge(scope, { userId: null, days, onProgress }));
    else {
      for (const u of users.filter((x) => !x.is_admin)) add(await adminPurge(scope, { userId: u.id, days, onProgress }));
    }
    return report(total);
  }

  function askPurge(scope: PurgeScope, only?: AdminUser) {
    const who = only ? `de ${only.email ?? only.id}` : includeSelf ? 'de TOUS les utilisateurs, ton compte inclus' : 'de tous les utilisateurs (ton compte exclu)';
    const what = scope === 'old' ? `les résultats non protégés de plus de ${days} jour(s)` : SCOPE_LABEL[scope];
    if (!confirm(`Supprimer en ligne ${what} ${who} ?\n\nLes dossiers locaux des utilisateurs ne sont pas touchés. Action définitive.`)) return;
    if (scope === 'all' && prompt('Tape PURGER pour confirmer la purge complète.')?.trim() !== 'PURGER') return;
    void act(`p-${scope}-${only?.id ?? 'all'}`, () => purge(scope, only));
  }

  if (error) {
    return (
      <div className={styles.page}>
        <div className={styles.pageHeader}><h1>Administration</h1></div>
        <section className={`card ${styles.section}`}>
          <p className={`${styles.note} ${styles.noteErr}`} style={{ marginTop: 0 }}>{error}</p>
          {missing && (
            <p className={styles.note}>
              Ouvre Supabase → SQL Editor, colle le contenu de <code>supabase/storage_admin.sql</code> (dans le projet) et exécute-le une fois.
              Recharge ensuite cette page. Le script n’efface rien : il ajoute les tables et fonctions de gestion.
            </p>
          )}
          <div className={styles.actions}><button type="button" className="btn btn-secondary btn-sm" onClick={() => void load()}>Réessayer</button></div>
        </section>
      </div>
    );
  }
  if (!ov) return <div className={styles.page}><p className={styles.muted}>Chargement…</p></div>;

  const dbPct = pct(ov.db_bytes, ov.db_limit);
  const stPct = pct(ov.storage_bytes, ov.storage_limit);

  return (
    <div className={styles.page}>
      <div className={styles.pageHeader}>
        <h1>Administration</h1>
        <p>Utilisateurs, consommation de Supabase et nettoyage. Cette page n’existe que pour toi : l’accès est vérifié côté serveur.</p>
      </div>

      {msg && <p className={`${styles.note} ${msg.kind === 'ok' ? styles.noteOk : styles.noteErr}`}>{msg.text}</p>}
      {progress && <p className={styles.note}>{progress}</p>}

      <div className={styles.grid}>
        <section className={`card ${styles.section}`}>
          <h2 className={styles.sectionTitle}>Base de données</h2>
          <div className={styles.bigNumber}>{fmtPct(dbPct)}<small>{fmtBytes(ov.db_bytes)} sur {fmtBytes(ov.db_limit)}</small></div>
          <Meter used={ov.db_bytes} total={ov.db_limit} />
          <p className={styles.faint}>Configurations, fiches de runs, données IBKR, réglages (inclut le système de Supabase).</p>
        </section>
        <section className={`card ${styles.section}`}>
          <h2 className={styles.sectionTitle}>Stockage de fichiers</h2>
          <div className={styles.bigNumber}>{fmtPct(stPct)}<small>{fmtBytes(ov.storage_bytes)} sur {fmtBytes(ov.storage_limit)}</small></div>
          <Meter used={ov.storage_bytes} total={ov.storage_limit} />
          <p className={styles.faint}>Résultats de backtest conservés en ligne.</p>
        </section>
      </div>

      <section className={`card ${styles.section}`} style={{ marginTop: '1.25rem' }}>
        <h2 className={styles.sectionTitle}>Règles</h2>
        <SettingsForm ov={ov} busy={!!busy} onSave={(fn, label) => act(`cfg-${label}`, async () => { await fn(); return 'Règles enregistrées.'; })} />
      </section>

      <section className={`card ${styles.section}`}>
        <h2 className={styles.sectionTitle}>Utilisateurs ({ov.user_count})</h2>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Utilisateur</th><th>Niveau</th><th>Quota (Mo)</th>
                <th className={styles.num}>Runs</th><th className={styles.num}>Fichiers en ligne</th><th className={styles.num}>Part</th>
                <th className={styles.num}>Base</th><th className={styles.num}>Config.</th><th>Dernier accès</th><th />
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <UserRow
                  key={u.id}
                  u={u}
                  self={u.id === selfId}
                  share={pct(u.storage_bytes, totalUserStorage)}
                  leanDefault={ov.lean_quota_bytes}
                  busy={!!busy}
                  onSave={(tier, quota) => act(`tier-${u.id}`, async () => { await adminSetUserTier(u.id, tier, quota); return `${u.email ?? 'Utilisateur'} : niveau ${tier === 'full' ? 'Complet' : 'Léger'} enregistré.`; })}
                  onPurge={(scope) => askPurge(scope, u)}
                />
              ))}
            </tbody>
          </table>
        </div>
        <p className={styles.faint} style={{ marginTop: '0.6rem' }}>
          Léger = résultats légers en ligne (quota), le reste dans le dossier de la personne. Complet = tout en ligne. Un changement s’applique au prochain run.
        </p>
      </section>

      <section className={`card ${styles.section}`}>
        <h2 className={styles.sectionTitle}>Purges</h2>
        <p className={styles.muted}>Elles visent le stockage en ligne. Les dossiers sur les PC des utilisateurs ne sont jamais touchés (chacun a son propre nettoyage automatique).</p>
        <div className={styles.fieldRow}>
          <label className={styles.check}>
            <input type="checkbox" checked={includeSelf} onChange={(e) => setIncludeSelf(e.target.checked)} />
            Inclure mon propre compte
          </label>
        </div>
        <div className={styles.danger}>
          <div className={styles.dangerItem}>
            <h3>Ménage par ancienneté</h3>
            <p className={styles.muted}>Supprime les résultats non protégés plus vieux que :</p>
            <div className={styles.fieldRow} style={{ marginTop: 0 }}>
              <label className={styles.field}>
                Jours
                <input type="number" min={0} max={3650} value={days} onChange={(e) => setDays(Math.max(0, Math.floor(Number(e.target.value) || 0)))} />
              </label>
              <button type="button" className="btn btn-secondary btn-sm" disabled={!!busy} onClick={() => askPurge('old')}>Nettoyer pour tout le monde</button>
            </div>
          </div>
          <div className={styles.dangerItem}>
            <h3>Purge partielle</h3>
            <p className={styles.muted}>Supprime tout l’historique de runs (fiches et fichiers). Les configurations sauvegardées, les données IBKR et les réglages restent.</p>
            <button type="button" className="btn btn-danger btn-sm" disabled={!!busy} onClick={() => askPurge('results')}>Purge partielle</button>
          </div>
          <div className={styles.dangerItem}>
            <h3>Purge complète</h3>
            <p className={styles.muted}>Supprime tout : historique, configurations sauvegardées, brouillons, données IBKR. Les comptes (connexion) et leurs niveaux restent.</p>
            <button type="button" className="btn btn-danger btn-sm" disabled={!!busy} onClick={() => askPurge('all')}>Purge complète…</button>
          </div>
        </div>
      </section>
    </div>
  );
}

function SettingsForm({ ov, busy, onSave }: { ov: AdminOverview; busy: boolean; onSave: (fn: () => Promise<void>, label: string) => void }) {
  const [tier, setTier] = useState(ov.default_tier);
  const [quota, setQuota] = useState(String(Math.round(ov.lean_quota_bytes / MB)));
  const [dbLimit, setDbLimit] = useState(String(Math.round(ov.db_limit / MB)));
  const [stLimit, setStLimit] = useState(String(Math.round(ov.storage_limit / MB)));
  const num = (s: string) => Math.max(1, Math.round(Number(s) || 0));
  return (
    <>
      <div className={styles.fieldRow}>
        <label className={styles.field}>
          Niveau des nouveaux utilisateurs
          <select value={tier} onChange={(e) => setTier(e.target.value as 'lean' | 'full')}>
            <option value="lean">Léger (recommandé)</option>
            <option value="full">Complet</option>
          </select>
        </label>
        <label className={styles.field}>
          Quota Léger (Mo)
          <input type="number" min={1} value={quota} onChange={(e) => setQuota(e.target.value)} />
        </label>
        <label className={styles.field}>
          Limite base (Mo)
          <input type="number" min={1} value={dbLimit} onChange={(e) => setDbLimit(e.target.value)} />
        </label>
        <label className={styles.field}>
          Limite fichiers (Mo)
          <input type="number" min={1} value={stLimit} onChange={(e) => setStLimit(e.target.value)} />
        </label>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={busy}
          onClick={() => onSave(async () => {
            await adminSetConfig('default_tier', tier);
            await adminSetConfig('lean_quota_bytes', num(quota) * MB);
            await adminSetConfig('db_limit_bytes', num(dbLimit) * MB);
            await adminSetConfig('storage_limit_bytes', num(stLimit) * MB);
          }, 'all')}
        >
          Enregistrer
        </button>
      </div>
      <p className={styles.faint} style={{ marginTop: '0.5rem' }}>
        Les limites base/fichiers servent seulement à calculer les pourcentages (offre Supabase gratuite : 500 Mo de base, 1 Go de fichiers).
      </p>
    </>
  );
}

function UserRow({ u, self, share, leanDefault, busy, onSave, onPurge }: {
  u: AdminUser;
  self: boolean;
  share: number;
  leanDefault: number;
  busy: boolean;
  onSave: (tier: 'lean' | 'full', quotaBytes: number | null) => void;
  onPurge: (scope: PurgeScope) => void;
}) {
  const [tier, setTier] = useState<'lean' | 'full'>(u.tier);
  const [quota, setQuota] = useState(u.own_tier && u.quota !== null ? String(Math.round(u.quota / MB)) : '');
  useEffect(() => {
    setTier(u.tier);
    setQuota(u.own_tier && u.quota !== null ? String(Math.round(u.quota / MB)) : '');
  }, [u.tier, u.own_tier, u.quota]);
  const dirty = tier !== u.tier || quota !== (u.own_tier && u.quota !== null ? String(Math.round(u.quota / MB)) : '');
  const quotaBytes = quota.trim() === '' ? null : Math.max(1, Math.round(Number(quota) || 0)) * MB;
  return (
    <tr className={self ? styles.rowSelf : undefined}>
      <td>
        <div className={styles.cellMain}>{u.email ?? u.id}</div>
        {u.is_admin && <span className={`${styles.badge} ${styles.badgeAdmin}`}>Admin</span>}
      </td>
      <td>
        {u.is_admin
          ? <span className={`${styles.badge} ${styles.badgeFull}`}>Complet</span>
          : (
            <select className={styles.tierSelect} value={tier} onChange={(e) => setTier(e.target.value as 'lean' | 'full')}>
              <option value="lean">Léger</option>
              <option value="full">Complet</option>
            </select>
          )}
      </td>
      <td>
        {u.is_admin ? <span className={styles.faint}>illimité</span> : (
          <input
            className={styles.quotaInput}
            type="number"
            min={1}
            value={quota}
            placeholder={tier === 'lean' ? String(Math.round(leanDefault / MB)) : '∞'}
            onChange={(e) => setQuota(e.target.value)}
          />
        )}
      </td>
      <td className={styles.num}>{u.runs}{u.pinned ? <span className={styles.faint}> ({u.pinned}★)</span> : null}</td>
      <td className={styles.num}>{fmtBytes(u.storage_bytes)}</td>
      <td className={styles.num}>{fmtPct(share)}</td>
      <td className={styles.num}>{fmtBytes(u.db_bytes)}</td>
      <td className={styles.num}>{u.configs}</td>
      <td className={styles.faint}>{fmtAgo(u.last_sign_in_at)}</td>
      <td>
        <div className={styles.actions} style={{ marginTop: 0 }}>
          {!u.is_admin && (
            <button type="button" className="btn btn-primary btn-sm" disabled={busy || !dirty} onClick={() => onSave(tier, quotaBytes)}>OK</button>
          )}
          <button type="button" className="btn btn-ghost btn-sm" disabled={busy || (u.storage_bytes === 0 && u.runs === 0)} onClick={() => onPurge('results')} title="Supprime l’historique de runs de cet utilisateur (garde configurations et IBKR)">
            Vider runs
          </button>
          {!u.is_admin && (
            <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => onPurge('all')} title="Supprime tout ce que cet utilisateur a enregistré (le compte reste)">
              Tout effacer
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}
