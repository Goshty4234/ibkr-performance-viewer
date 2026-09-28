'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { jsonFromPdf, jsonToPdf } from '@/lib/backtest/json-pdf';
import { exportJson, exportPortfolioJson } from '@/lib/backtest/portfolio';
import { useBacktestStore } from '@/lib/backtest/store';
import styles from './Backtester.module.css';

function fileSlug(name: string): string {
  return name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\w-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'portfolio';
}

export default function ImportExportDialog({
  mode,
  portfolioId,
  onClose,
}: {
  mode: 'import' | 'export';
  /** Export only this portfolio (single JSON object) instead of the whole list. */
  portfolioId?: string;
  onClose: () => void;
}) {
  const portfolios = useBacktestStore((s) => s.portfolios);
  const options = useBacktestStore((s) => s.options);
  const importJson = useBacktestStore((s) => s.importJson);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [fileName, setFileName] = useState('');
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  async function readFile(f: File) {
    setError('');
    try {
      const isPdf = f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
      setText(isPdf ? await jsonFromPdf(f) : await f.text());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const single = portfolioId ? portfolios.find((p) => p._id === portfolioId) ?? null : null;
  const exported = useMemo(() => {
    if (mode !== 'export') return '';
    return single ? exportPortfolioJson(single, options) : exportJson(portfolios, options);
  }, [mode, single, portfolios, options]);

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

  const day = new Date().toISOString().slice(0, 10);
  const defaultName = single ? `${fileSlug(single.name)}-${day}` : `portfolios-${day}`;
  const baseName = fileName.trim() ? fileSlug(fileName.trim()) : defaultName;

  function save(blob: Blob, ext: 'json' | 'pdf') {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${baseName}.${ext}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const exportTitle = single ? `JSON de « ${single.name} »` : `Exporter ${portfolios.length} portfolios`;
  const pdfTitle = fileName.trim() || (single ? `${single.name} · configuration JSON` : `${portfolios.length} portfolios · configuration JSON`);

  return (
    <div className={styles.overlay} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={styles.dialog} role="dialog" aria-modal="true">
        <div className={styles.dialogHead}>
          <span className={styles.dialogTitle}>{mode === 'import' ? 'Importer des portfolios' : exportTitle}</span>
          <button type="button" className={styles.iconBtn} onClick={onClose} aria-label="Fermer">✕</button>
        </div>

        {mode === 'import' ? (
          <>
            <p className={styles.sectionSub}>
              Colle le JSON « export all portfolios » de Streamlit (ou un fichier exporté ici), ou glisse un fichier .json ou un
              PDF de configuration (celui de Streamlit ou d’ici). Les options globales (début, premier rebalancement, dates)
              sont reprises automatiquement. Le JSON d’un seul portfolio peut aussi remplacer le portfolio sélectionné.
            </p>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder='[{"name": "...", "stocks": [...]}]  ·  ou dépose un fichier .json / .pdf ici'
              autoFocus
              className={dragging ? styles.dropActive : undefined}
              onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                const f = e.dataTransfer.files?.[0];
                if (f) void readFile(f);
              }}
            />
            <input
              ref={fileRef}
              type="file"
              accept=".json,.pdf,application/json,application/pdf,text/plain"
              style={{ display: 'none' }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void readFile(f);
                e.target.value = '';
              }}
            />
            {error && <div className={styles.errorBox}>{error}</div>}
            <div className={styles.dialogActions}>
              <button type="button" className="btn btn-ghost" onClick={() => fileRef.current?.click()}>Ouvrir un fichier (.json / .pdf)…</button>
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
            <p className={styles.sectionSub}>
              {single
                ? 'Format du JSON individuel de Streamlit (options globales incluses). Il se réimporte avec « Ajouter » ou « Mettre à jour le portfolio actif ».'
                : 'Format compatible avec l’import « paste all » de Streamlit.'}
            </p>
            <textarea value={exported} readOnly />
            <label className={styles.fileNameField}>
              Nom du fichier (optionnel)
              <input
                type="text"
                className="input"
                value={fileName}
                placeholder={defaultName}
                onChange={(e) => setFileName(e.target.value)}
              />
            </label>
            <div className={styles.dialogActions}>
              <button type="button" className="btn btn-ghost" onClick={() => save(new Blob([exported], { type: 'application/json' }), 'json')}>
                Télécharger .json
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                title="PDF avec le JSON en texte (Ctrl+A / Ctrl+C) ; il se réimporte ici tel quel"
                onClick={() => save(jsonToPdf(exported, pdfTitle), 'pdf')}
              >
                Télécharger .pdf
              </button>
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
