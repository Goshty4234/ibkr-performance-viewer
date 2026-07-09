'use client';

import { useCallback, useState } from 'react';
import styles from './FileUpload.module.css';

interface Props {
  onFiles: (files: FileList) => void;
  uploading: boolean;
}

export default function FileUpload({ onFiles, uploading }: Props) {
  const [dragging, setDragging] = useState(false);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files.length) onFiles(e.dataTransfer.files);
  }, [onFiles]);

  return (
    <div
      className={`${styles.zone} ${dragging ? styles.dragging : ''} ${uploading ? styles.uploading : ''}`}
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      onClick={() => document.getElementById('csv-input')?.click()}
    >
      <input
        id="csv-input"
        type="file"
        accept=".csv"
        multiple
        hidden
        onChange={(e) => e.target.files && onFiles(e.target.files)}
      />
      <div className={styles.icon}>{uploading ? '⏳' : '📊'}</div>
      <div className={styles.title}>
        {uploading ? 'Import en cours…' : <>Glissez vos <strong>Activity Statements IBKR</strong></>}
      </div>
      <div className={styles.hint}>CSV · Plusieurs fichiers · Sauvegardé dans Supabase</div>
    </div>
  );
}
