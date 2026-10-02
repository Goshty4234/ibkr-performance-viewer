'use client';

import { useState } from 'react';
import { ENGINE_DOWNLOAD_URL } from '@/lib/engine/prefs';
import { useEngineStore } from '@/lib/engine/store';
import styles from './EngineSetup.module.css';

/** Shown while no engine answers: get the portable engine, start it, let the page find it. */
export default function EngineSetup({ compact = false }: { compact?: boolean }) {
  const detect = useEngineStore((s) => s.detect);
  const mode = useEngineStore((s) => s.prefs.mode);
  const cloudUrl = useEngineStore((s) => s.prefs.cloudUrl);
  const [checking, setChecking] = useState(false);
  const [missed, setMissed] = useState(false);

  if (mode === 'cloud') {
    return (
      <span className={styles.line}>
        Le moteur en ligne {cloudUrl ? `(${cloudUrl}) ne répond pas` : 'n’est pas configuré'} — passe en « Auto » ou « Mon PC » pour calculer sur ton PC.
      </span>
    );
  }

  async function check() {
    setChecking(true);
    setMissed(false);
    const found = await detect({ forceLocal: true });
    setChecking(false);
    setMissed(!found);
  }

  return (
    <div className={compact ? styles.compact : styles.box}>
      <span className={styles.title}>Aucun moteur détecté — calcule sur ton PC :</span>
      <span className={styles.steps}>
        <a className="btn btn-primary btn-sm" href={ENGINE_DOWNLOAD_URL} download>
          ⬇ Télécharger le moteur (Windows)
        </a>
        <span>décompresse, double-clique « Lancer le moteur », puis</span>
        <button type="button" className="btn btn-secondary btn-sm" disabled={checking} onClick={() => void check()}>
          {checking ? 'Recherche…' : 'J’ai lancé le moteur'}
        </button>
      </span>
      <span className={styles.note}>
        Rien à installer : Python et les librairies sont dans le dossier. Chrome / Edge demandent une fois l’accès aux
        appareils locaux : clique « Autoriser ».
        {missed && <b> Pas encore trouvé : le premier démarrage prend ~20 s, réessaie dans un instant.</b>}
      </span>
    </div>
  );
}
