'use client';

import { useEffect, useState } from 'react';
import type { EngineMode } from '@/lib/engine/prefs';
import { useEngineStore } from '@/lib/engine/store';
import styles from './settings.module.css';

export default function EngineSettings() {
  const { prefs, status, engine, init, setPrefs } = useEngineStore();
  const [mode, setMode] = useState<EngineMode>(prefs.mode);
  const [cloudUrl, setCloudUrl] = useState(prefs.cloudUrl);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => { init(); }, [init]);
  useEffect(() => { setMode(prefs.mode); setCloudUrl(prefs.cloudUrl); }, [prefs.mode, prefs.cloudUrl]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setMessage('');
    await setPrefs({ mode, cloudUrl });
    setSaving(false);
    const s = useEngineStore.getState();
    setMessage(
      s.engine
        ? `Enregistré ✓ — connecté au moteur ${s.engine.kind === 'local' ? 'de ce PC' : 'en ligne'}.`
        : 'Enregistré ✓ — aucun moteur ne répond pour le moment.',
    );
  }

  return (
    <section className={`card ${styles.section}`}>
      <h2 className={styles.sectionTitle}>Moteur de backtest</h2>
      <form onSubmit={save} className={styles.form}>
        <label>
          Où lancer les calculs
          <select value={mode} onChange={(e) => setMode(e.target.value as EngineMode)}>
            <option value="auto">Automatique — ce PC si le moteur local tourne, sinon en ligne</option>
            <option value="local">Toujours ce PC</option>
            <option value="cloud">Toujours en ligne</option>
          </select>
        </label>
        <label>
          Adresse du moteur en ligne
          <input
            type="text"
            value={cloudUrl}
            onChange={(e) => setCloudUrl(e.target.value)}
            placeholder="https://moteur.mondomaine.com"
            spellCheck={false}
          />
        </label>
        <p className={styles.infoLabel}>
          L&apos;adresse peut changer à tout moment (Oracle, autre VPS, serveur payant…) : le site utilise
          simplement celle-ci. Elle est enregistrée dans ton compte et suit tous tes appareils.
          Statut actuel :{' '}
          {status === 'ready' && engine
            ? `connecté (${engine.kind === 'local' ? 'ce PC' : 'en ligne'}, ${engine.url})`
            : status === 'offline' ? 'aucun moteur joignable' : 'détection…'}
        </p>
        {message && <p className={`${styles.message} ${styles.messageSuccess}`}>{message}</p>}
        <div className={styles.actions}>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? 'Test de connexion…' : 'Enregistrer'}
          </button>
        </div>
      </form>
    </section>
  );
}
