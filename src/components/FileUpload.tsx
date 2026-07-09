'use client';

import { useCallback, useId, useState } from 'react';
import styles from './FileUpload.module.css';

interface Props {
  onFiles: (files: FileList) => void | Promise<void>;
  uploading: boolean;
  accountHint?: string;
}

export default function FileUpload({ onFiles, uploading, accountHint }: Props) {
  const inputId = useId();
  const [dragging, setDragging] = useState(false);

  const deliverFiles = useCallback((files: FileList | null | undefined) => {
    if (!files?.length) return;
    Promise.resolve(onFiles(files)).catch((err: unknown) => {
      console.error('Import CSV:', err);
    });
  }, [onFiles]);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragging(false);
    deliverFiles(e.dataTransfer.files);
  }, [deliverFiles]);

  return (
    <label
      htmlFor={inputId}
      className={`${styles.zone} ${dragging ? styles.dragging : ''} ${uploading ? styles.uploading : ''}`}
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <input
        id={inputId}
        type="file"
        accept=".csv"
        multiple
        className={styles.fileInput}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => {
          deliverFiles(e.target.files);
          e.target.value = '';
        }}
      />
      <div className={styles.iconWrap}>{uploading ? '⏳' : '📊'}</div>
      <div className={styles.title}>
        {uploading ? 'Import en cours…' : <>Glissez vos CSV IBKR <strong>(Statement ou Flex NAV)</strong></>}
      </div>
      <div className={styles.hint}>
        CSV · Plusieurs fichiers · Sauvegardé dans Supabase
        {accountHint && accountHint !== 'Tous les comptes' && ` · Compte : ${accountHint}`}
      </div>
    </label>
  );
}
