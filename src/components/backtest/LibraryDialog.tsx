'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { deleteSaved, isSavedRun, listSaved, savePortfolios, saveRun, type SavedPortfolio, updateSaved } from '@/lib/backtest/library';
import { toEngineConfig } from '@/lib/backtest/portfolio';
import { useBacktestStore } from '@/lib/backtest/store';
import type { PortfolioConfig } from '@/lib/engine/types';
import { isGuest } from '@/lib/guest';
import styles from './Backtester.module.css';

function strategyTags(p: PortfolioConfig): string[] {
  const tags: string[] = [];
  if (p.fusion_portfolio?.enabled) tags.push('Fusion');
  if (p.use_momentum) tags.push('Momentum');
  if (p.use_sma_filter) tags.push('MA');
  if (p.use_targeted_rebalancing && !p.use_momentum && !p.use_sma_filter) tags.push('Ciblé');
  if (!tags.length) tags.push('Buy & hold');
  return tags;
}

function portfoliosOf(r: SavedPortfolio): PortfolioConfig[] {
  return isSavedRun(r.config) ? r.config.portfolios : [{ ...r.config, name: r.name }];
}

function defaultRunName(portfolios: { name: string }[]): string {
  const day = new Date().toLocaleDateString('fr-CA');
  if (!portfolios.length) return `Run du ${day}`;
  return portfolios.length === 1 ? portfolios[0].name : `${portfolios[0].name} + ${portfolios.length - 1} · ${day}`;
}

type SaveScope = 'run' | 'selected';

export default function LibraryDialog({ onClose, scope }: { onClose: () => void; scope?: SaveScope }) {
  const setView = useBacktestStore((s) => s.setView);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className={styles.overlay} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`${styles.dialog} ${styles.dialogWide}`} role="dialog" aria-modal="true">
        <div className={styles.dialogHead}>
          <span className={styles.dialogTitle}>Enregistrements</span>
          <button type="button" className={styles.iconBtn} onClick={onClose} aria-label="Fermer">✕</button>
        </div>
        <LibraryPanel initialScope={scope} onLoaded={() => { setView('build'); onClose(); }} />
      </div>
    </div>
  );
}

/** Enregistrements: the section of saves made on purpose, apart from the automatic run history. */
export function SavesView() {
  const setView = useBacktestStore((s) => s.setView);
  if (isGuest()) {
    return (
      <div className={`card ${styles.empty}`}>
        <h2>Indisponible en mode invité</h2>
        <p>Crée un compte pour enregistrer tes portfolios et tes runs et les retrouver sur tous tes appareils.</p>
      </div>
    );
  }
  return (
    <div className={`card ${styles.section}`}>
      <LibraryPanel onLoaded={() => setView('build')} />
    </div>
  );
}

/** Saves of the account: one portfolio, or a whole run (all portfolios + settings) as a single save. */
export function LibraryPanel({ onLoaded, initialScope }: { onLoaded: (count: number) => void; initialScope?: SaveScope }) {
  const portfolios = useBacktestStore((s) => s.portfolios);
  const selectedId = useBacktestStore((s) => s.selectedId);
  const options = useBacktestStore((s) => s.options);
  const importJson = useBacktestStore((s) => s.importJson);
  const [rows, setRows] = useState<SavedPortfolio[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [scope, setScope] = useState<SaveScope>(initialScope ?? (portfolios.length > 1 ? 'run' : 'selected'));
  const [folder, setFolder] = useState('');
  const [query, setQuery] = useState('');
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const active = portfolios.find((p) => p._id === selectedId) ?? portfolios[0];
  const suggested = scope === 'run' ? defaultRunName(portfolios) : (active?.name ?? '');
  const [name, setName] = useState('');

  const refresh = useCallback(async () => {
    try {
      setRows(await listSaved());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setRows([]);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const folders = useMemo(() => [...new Set((rows ?? []).map((r) => r.folder).filter(Boolean))].sort(), [rows]);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const map = new Map<string, SavedPortfolio[]>();
    for (const r of rows ?? []) {
      if (q && !r.name.toLowerCase().includes(q) && !r.folder.toLowerCase().includes(q)
        && !portfoliosOf(r).some((p) => p.name.toLowerCase().includes(q) || p.stocks?.some((s) => s.ticker.toLowerCase().includes(q)))) continue;
      const list = map.get(r.folder) ?? [];
      list.push(r);
      map.set(r.folder, list);
    }
    return [...map.entries()].sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)));
  }, [rows, query]);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const canSave = scope === 'run' ? portfolios.length > 0 : Boolean(active);

  function save() {
    const dir = folder.trim();
    const label = name.trim() || suggested;
    const where = dir ? `« ${dir} »` : 'Sans dossier';
    if (rows?.some((r) => r.folder === dir && r.name === label)
      && !confirm(`« ${label} » existe déjà dans ${where}.\nRemplacer par la configuration actuelle ?`)) return;
    run(async () => {
      if (scope === 'run') {
        await saveRun(label, dir, portfolios.map(toEngineConfig), options);
        setNotice(`Run « ${label} » enregistré (${portfolios.length} portfolio${portfolios.length > 1 ? 's' : ''}) dans ${where}.`);
      } else if (active) {
        await savePortfolios([{ ...toEngineConfig(active), name: label }], dir);
        setNotice(`« ${label} » enregistré dans ${where}.`);
      }
      setName('');
      await refresh();
    });
  }

  function load(ids: string[], mode: 'append' | 'replace') {
    const picked = (rows ?? []).filter((r) => ids.includes(r.id));
    const list = picked.flatMap(portfoliosOf);
    if (!list.length) return;
    if (mode === 'replace' && portfolios.length && !confirm(`Remplacer les ${portfolios.length} portfolios actuels par ${list.length === 1 ? 'celui-ci' : `ces ${list.length}`} ?`)) return;
    // A single run save brings its settings back with it; a mix of saves keeps the current ones.
    const runs = picked.filter((r) => isSavedRun(r.config));
    const savedOptions = mode === 'replace' && picked.length === 1 && runs.length === 1 && isSavedRun(runs[0].config) ? runs[0].config.options : undefined;
    try {
      importJson(JSON.stringify(savedOptions ? { portfolios: list, options: savedOptions } : list), mode);
      onLoaded(list.length);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function toggle(id: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  const checkedIds = [...checked].filter((id) => rows?.some((r) => r.id === id));

  return (
    <>
        <p className={styles.sectionSub}>
          Ce que tu gardes exprès, dans ton compte : sur tous tes appareils, jamais supprimé automatiquement
          (l’Historique, lui, garde chaque run 30 jours). Un run enregistré ramène tous ses portfolios et ses réglages d’un coup.
        </p>

        <div className={styles.libSave}>
          <div className={styles.segmented}>
            <button type="button" className={scope === 'run' ? styles.segActive : ''} onClick={() => setScope('run')} title="Tous les portfolios de Construire et les réglages du run (dates, départ), en une seule sauvegarde">
              Tout le run ({portfolios.length})
            </button>
            <button type="button" className={scope === 'selected' ? styles.segActive : ''} onClick={() => setScope('selected')} title="Seulement le portfolio ouvert dans Construire">
              Portfolio ouvert
            </button>
          </div>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={suggested || 'Nom'}
            className={styles.libFolder}
            aria-label="Nom de l’enregistrement"
            title="Nom de la sauvegarde (vide = celui proposé)"
          />
          <input
            list="lib-folders"
            value={folder}
            onChange={(e) => setFolder(e.target.value)}
            placeholder="Dossier (optionnel)"
            className={styles.libFolder}
          />
          <datalist id="lib-folders">{folders.map((f) => <option key={f} value={f} />)}</datalist>
          <button type="button" className="btn btn-primary" disabled={busy || !canSave} onClick={save}>
            💾 Enregistrer
          </button>
        </div>
        <p className={styles.sectionSub}>Même nom dans le même dossier : l’ancien est remplacé (confirmation demandée).</p>

        {notice && <div className={styles.noticeBox}>{notice}</div>}
        {error && <div className={styles.errorBox}>{error}</div>}

        <div className={styles.libToolbar}>
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Chercher un nom, un dossier, un portfolio ou un ticker…" />
          <button type="button" className="btn btn-secondary btn-sm" disabled={!checkedIds.length} onClick={() => load(checkedIds, 'append')} title="Ajoute les portfolios des sauvegardes cochées à ceux de Construire">
            Ajouter la sélection ({checkedIds.length})
          </button>
          <button type="button" className="btn btn-ghost btn-sm" disabled={!checkedIds.length} onClick={() => load(checkedIds, 'replace')} title="Remplace tous les portfolios de Construire par ceux des sauvegardes cochées">
            Remplacer tout
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={!checkedIds.length || busy}
            onClick={() => {
              if (!confirm(`Supprimer ${checkedIds.length} enregistrement(s) ?`)) return;
              run(async () => { await deleteSaved(checkedIds); setChecked(new Set()); await refresh(); });
            }}
          >
            Supprimer
          </button>
        </div>

        <div className={styles.libList}>
          {rows === null && <div className={styles.sectionSub}>Chargement…</div>}
          {rows !== null && !groups.length && (
            <div className={styles.sectionSub}>{rows.length ? 'Aucun résultat.' : 'Rien d’enregistré pour l’instant. Enregistre un run ou un portfolio ci-dessus.'}</div>
          )}
          {groups.map(([dir, list]) => (
            <div key={dir || '__root'} className={styles.libGroup}>
              <div className={styles.libGroupHead}>
                <span>{dir || 'Sans dossier'}</span>
                <span className={styles.sectionSub}>{list.length}</span>
              </div>
              {list.map((r) => {
                const saved = isSavedRun(r.config) ? r.config : null;
                return (
                  <div key={r.id} className={styles.libRow}>
                    <input type="checkbox" checked={checked.has(r.id)} onChange={() => toggle(r.id)} aria-label={`Sélectionner ${r.name}`} />
                    <div className={styles.libMain}>
                      <div className={styles.libName}>{r.name}</div>
                      <div className={styles.libMeta}>
                        {saved ? (
                          <>
                            <span className={styles.libTag}>Run · {saved.portfolios.length} portfolio{saved.portfolios.length > 1 ? 's' : ''}</span>
                            <span>{saved.portfolios.slice(0, 6).map((p) => p.name).join(', ')}{saved.portfolios.length > 6 ? '…' : ''}</span>
                          </>
                        ) : (
                          <>
                            {strategyTags(r.config as PortfolioConfig).map((t) => <span key={t} className={styles.libTag}>{t}</span>)}
                            <span>{((r.config as PortfolioConfig).stocks ?? []).filter((s) => s.ticker).map((s) => s.ticker).slice(0, 8).join(', ')}
                              {((r.config as PortfolioConfig).stocks ?? []).length > 8 ? '…' : ''}</span>
                          </>
                        )}
                        <span>· {new Date(r.updated_at).toLocaleDateString('fr-CA')}</span>
                      </div>
                    </div>
                    <div className={styles.libActions}>
                      {saved ? (
                        <>
                          <button type="button" className="btn btn-primary btn-sm" onClick={() => load([r.id], 'replace')} title="Remplace les portfolios de Construire par ceux de ce run, avec ses réglages">
                            Ouvrir
                          </button>
                          <button type="button" className="btn btn-ghost btn-sm" onClick={() => load([r.id], 'append')} title="Ajoute les portfolios de ce run à ceux de Construire">
                            Ajouter
                          </button>
                        </>
                      ) : (
                        <button type="button" className="btn btn-secondary btn-sm" onClick={() => load([r.id], 'append')}>Charger</button>
                      )}
                      <button
                        type="button"
                        className={styles.iconBtn}
                        title="Renommer"
                        disabled={busy}
                        onClick={() => {
                          const next = prompt('Nouveau nom', r.name)?.trim();
                          if (next && next !== r.name) run(async () => { await updateSaved(r.id, { name: next }); await refresh(); });
                        }}
                      >
                        ✎
                      </button>
                      <button
                        type="button"
                        className={styles.iconBtn}
                        title="Déplacer dans un dossier"
                        disabled={busy}
                        onClick={() => {
                          const dest = prompt('Dossier (vide = sans dossier)', r.folder);
                          if (dest !== null && dest.trim() !== r.folder) run(async () => { await updateSaved(r.id, { folder: dest }); await refresh(); });
                        }}
                      >
                        ⇄
                      </button>
                      <button
                        type="button"
                        className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
                        title="Supprimer"
                        disabled={busy}
                        onClick={() => {
                          if (confirm(`Supprimer l’enregistrement « ${r.name} » ?`)) run(async () => { await deleteSaved([r.id]); await refresh(); });
                        }}
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
    </>
  );
}
