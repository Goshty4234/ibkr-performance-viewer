'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { deleteSaved, listSaved, savePortfolios, type SavedPortfolio, updateSaved } from '@/lib/backtest/library';
import { toEngineConfig } from '@/lib/backtest/portfolio';
import { useBacktestStore } from '@/lib/backtest/store';
import styles from './Backtester.module.css';

function strategyTags(p: SavedPortfolio['config']): string[] {
  const tags: string[] = [];
  if (p.fusion_portfolio?.enabled) tags.push('Fusion');
  if (p.use_momentum) tags.push('Momentum');
  if (p.use_sma_filter) tags.push('MA');
  if (p.use_targeted_rebalancing && !p.use_momentum && !p.use_sma_filter) tags.push('Ciblé');
  if (!tags.length) tags.push('Buy & hold');
  return tags;
}

export default function LibraryDialog({ onClose }: { onClose: () => void }) {
  const portfolios = useBacktestStore((s) => s.portfolios);
  const selectedId = useBacktestStore((s) => s.selectedId);
  const importJson = useBacktestStore((s) => s.importJson);
  const [rows, setRows] = useState<SavedPortfolio[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [scope, setScope] = useState<'selected' | 'all'>('selected');
  const [folder, setFolder] = useState('');
  const [query, setQuery] = useState('');
  const [checked, setChecked] = useState<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    try {
      setRows(await listSaved());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setRows([]);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const folders = useMemo(() => [...new Set((rows ?? []).map((r) => r.folder).filter(Boolean))].sort(), [rows]);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const map = new Map<string, SavedPortfolio[]>();
    for (const r of rows ?? []) {
      if (q && !r.name.toLowerCase().includes(q) && !r.folder.toLowerCase().includes(q)
        && !r.config.stocks?.some((s) => s.ticker.toLowerCase().includes(q))) continue;
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

  const active = portfolios.find((p) => p._id === selectedId) ?? portfolios[0];
  const toSave = scope === 'all' ? portfolios : active ? [active] : [];

  function save() {
    run(async () => {
      const n = await savePortfolios(toSave.map(toEngineConfig), folder);
      setNotice(`${n} portfolio${n > 1 ? 's' : ''} enregistré${n > 1 ? 's' : ''} dans ${folder.trim() || 'la racine'}.`);
      await refresh();
    });
  }

  function load(ids: string[], mode: 'append' | 'replace') {
    const list = (rows ?? []).filter((r) => ids.includes(r.id)).map((r) => ({ ...r.config, name: r.name }));
    if (!list.length) return;
    if (mode === 'replace' && portfolios.length && !confirm(`Remplacer les ${portfolios.length} portfolios actuels ?`)) return;
    try {
      importJson(JSON.stringify(list), mode);
      onClose();
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
    <div className={styles.overlay} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`${styles.dialog} ${styles.dialogWide}`} role="dialog" aria-modal="true">
        <div className={styles.dialogHead}>
          <span className={styles.dialogTitle}>Ma bibliothèque de portfolios</span>
          <button type="button" className={styles.iconBtn} onClick={onClose} aria-label="Fermer">✕</button>
        </div>
        <p className={styles.sectionSub}>
          Enregistrés dans ton compte Supabase : retrouvables sur tous tes appareils, et utilisables dans le
          backtester comme dans la page Allocations.
        </p>

        <div className={styles.libSave}>
          <div className={styles.segmented}>
            <button type="button" className={scope === 'selected' ? styles.segActive : ''} onClick={() => setScope('selected')}>
              {active ? `« ${active.name} »` : 'Portfolio sélectionné'}
            </button>
            <button type="button" className={scope === 'all' ? styles.segActive : ''} onClick={() => setScope('all')}>
              Tous ({portfolios.length})
            </button>
          </div>
          <input
            list="lib-folders"
            value={folder}
            onChange={(e) => setFolder(e.target.value)}
            placeholder="Dossier (optionnel)"
            className={styles.libFolder}
          />
          <datalist id="lib-folders">{folders.map((f) => <option key={f} value={f} />)}</datalist>
          <button type="button" className="btn btn-primary" disabled={busy || !toSave.length} onClick={save}>
            Enregistrer
          </button>
        </div>
        <p className={styles.sectionSub}>Un portfolio du même nom dans le même dossier est mis à jour.</p>

        {notice && <div className={styles.noticeBox}>{notice}</div>}
        {error && <div className={styles.errorBox}>{error}</div>}

        <div className={styles.libToolbar}>
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Chercher un nom, un dossier ou un ticker…" />
          <button type="button" className="btn btn-secondary btn-sm" disabled={!checkedIds.length} onClick={() => load(checkedIds, 'append')}>
            Ajouter ({checkedIds.length})
          </button>
          <button type="button" className="btn btn-ghost btn-sm" disabled={!checkedIds.length} onClick={() => load(checkedIds, 'replace')}>
            Remplacer tout
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={!checkedIds.length || busy}
            onClick={() => {
              if (!confirm(`Supprimer ${checkedIds.length} portfolio(s) de la bibliothèque ?`)) return;
              run(async () => { await deleteSaved(checkedIds); setChecked(new Set()); await refresh(); });
            }}
          >
            Supprimer
          </button>
        </div>

        <div className={styles.libList}>
          {rows === null && <div className={styles.sectionSub}>Chargement…</div>}
          {rows !== null && !groups.length && (
            <div className={styles.sectionSub}>{rows.length ? 'Aucun résultat.' : 'Ta bibliothèque est vide. Enregistre un portfolio ci-dessus.'}</div>
          )}
          {groups.map(([dir, list]) => (
            <div key={dir || '__root'} className={styles.libGroup}>
              <div className={styles.libGroupHead}>
                <span>{dir || 'Sans dossier'}</span>
                <span className={styles.sectionSub}>{list.length}</span>
              </div>
              {list.map((r) => (
                <div key={r.id} className={styles.libRow}>
                  <input type="checkbox" checked={checked.has(r.id)} onChange={() => toggle(r.id)} aria-label={`Sélectionner ${r.name}`} />
                  <div className={styles.libMain}>
                    <div className={styles.libName}>{r.name}</div>
                    <div className={styles.libMeta}>
                      {strategyTags(r.config).map((t) => <span key={t} className={styles.libTag}>{t}</span>)}
                      <span>{(r.config.stocks ?? []).filter((s) => s.ticker).map((s) => s.ticker).slice(0, 8).join(', ')}
                        {(r.config.stocks ?? []).length > 8 ? '…' : ''}</span>
                      <span>· {new Date(r.updated_at).toLocaleDateString('fr-CA')}</span>
                    </div>
                  </div>
                  <div className={styles.libActions}>
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => load([r.id], 'append')}>Charger</button>
                    <button
                      type="button"
                      className={styles.iconBtn}
                      title="Renommer"
                      disabled={busy}
                      onClick={() => {
                        const name = prompt('Nouveau nom', r.name)?.trim();
                        if (name && name !== r.name) run(async () => { await updateSaved(r.id, { name }); await refresh(); });
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
                        if (confirm(`Supprimer « ${r.name} » de la bibliothèque ?`)) run(async () => { await deleteSaved([r.id]); await refresh(); });
                      }}
                    >
                      ✕
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
