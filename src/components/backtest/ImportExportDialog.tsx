'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { exportJson } from '@/lib/backtest/portfolio';
import { useBacktestStore } from '@/lib/backtest/store';
import styles from './Backtester.module.css';

export default function ImportExportDialog({ mode, onClose }: { mode: 'import' | 'export'; onClose: () => void }) {
  const portfolios = useBacktestStore((s) => s.portfolios);
  const options = useBacktestStore((s) => s.options);
  const importJson = useBacktestStore((s) => s.importJson);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const exported = useMemo(() => (mode === 'export' ? exportJson(portfolios, options) : ''), [mode, portfolios, options]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  function doImport(importMode: 'replace' | 'append' | 'active') {
    setError('');
    try {
      if (importMode === 'replace' && portfolios.length && !confirm(`Remplacer les ${portfolios.length} portfolios actuels ?`)) return;
      importJson(text, importMode);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function download() {
    const blob = new Blob([exported], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `portfolios-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className={styles.overlay} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={styles.dialog} role="dialog" aria-modal="true">
        <div className={styles.dialogHead}>
          <span className={styles.dialogTitle}>
            {mode === 'import' ? 'Importer des portfolios' : `Exporter ${portfolios.length} portfolios`}
          </span>
          <button type="button" className={styles.iconBtn} onClick={onClose} aria-label="Fermer">✕</button>
        </div>

        {mode === 'import' ? (
          <>
            <p className={styles.sectionSub}>
              Colle le JSON « export all portfolios » de Streamlit (ou un fichier exporté ici). Les options globales
              (début, premier rebalancement, dates) sont reprises automatiquement. Le JSON d’un seul portfolio peut aussi
              remplacer le portfolio sélectionné.
            </p>
            <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder='[{"name": "...", "stocks": [...]}]' autoFocus />
            <input
              ref={fileRef}
              type="file"
              accept=".json,application/json,text/plain"
              style={{ display: 'none' }}
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (f) setText(await f.text());
              }}
            />
            {error && <div className={styles.errorBox}>{error}</div>}
            <div className={styles.dialogActions}>
              <button type="button" className="btn btn-ghost" onClick={() => fileRef.current?.click()}>Ouvrir un fichier…</button>
              <button
                type="button"
                className="btn btn-ghost"
                disabled={!text.trim() || !portfolios.length}
                title="Met à jour le portfolio sélectionné avec le JSON collé (un seul portfolio)"
                onClick={() => doImport('active')}
              >
                Mettre à jour le portfolio actif
              </button>
              <button type="button" className="btn btn-secondary" disabled={!text.trim()} onClick={() => doImport('append')}>Ajouter</button>
              <button type="button" className="btn btn-primary" disabled={!text.trim()} onClick={() => doImport('replace')}>Remplacer tout</button>
            </div>
          </>
        ) : (
          <>
            <p className={styles.sectionSub}>Format compatible avec l&apos;import « paste all » de Streamlit.</p>
            <textarea value={exported} readOnly />
            <div className={styles.dialogActions}>
              <button type="button" className="btn btn-ghost" onClick={download}>Télécharger .json</button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={async () => {
                  await navigator.clipboard.writeText(exported);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }}
              >
                {copied ? 'Copié ✓' : 'Copier'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
