'use client';

import { useEffect, useState } from 'react';
import { localEngineKnown } from '@/lib/engine/client';
import { ENGINE_DOWNLOAD_URL } from '@/lib/engine/prefs';
import { useEngineStore } from '@/lib/engine/store';
import styles from './EngineSetup.module.css';

/** Shown while no engine answers. Usually the engine is installed but not started: one click starts
 * it (momentum-engine:// link registered by the engine itself). The download is for a first install. */
export default function EngineSetup({ compact = false }: { compact?: boolean }) {
  const mode = useEngineStore((s) => s.prefs.mode);
  const cloudUrl = useEngineStore((s) => s.prefs.cloudUrl);
  const launching = useEngineStore((s) => s.launching);
  const launchFailed = useEngineStore((s) => s.launchFailed);
  const launchLocal = useEngineStore((s) => s.launchLocal);
  // Read after mount: localStorage does not exist during the server render.
  const [known, setKnown] = useState(false);
  useEffect(() => setKnown(localEngineKnown()), []);

  if (mode === 'cloud') {
    return (
      <span className={styles.line}>
        Le moteur en ligne {cloudUrl ? `(${cloudUrl}) ne répond pas` : 'n’est pas configuré'} — passe en « Auto » ou « Mon PC » pour calculer sur ton PC.
      </span>
    );
  }

  return (
    <div className={compact ? styles.compact : styles.box}>
      <span className={styles.title}>{known ? 'Ton moteur n’est pas lancé.' : 'Aucun moteur lancé sur ce PC.'}</span>
      <span className={styles.steps}>
        <button type="button" className="btn btn-primary btn-sm" disabled={launching} onClick={() => void launchLocal()}>
          {launching ? '⟳ Démarrage du moteur…' : '▶ Lancer le moteur'}
        </button>
        {known ? (
          <a className={styles.minor} href={ENGINE_DOWNLOAD_URL} download>
            Pas encore installé sur ce PC ? Télécharger
          </a>
        ) : (
          <a className="btn btn-secondary btn-sm" href={ENGINE_DOWNLOAD_URL} download>
            ⬇ Première fois : télécharger (Windows)
          </a>
        )}
      </span>
      <span className={styles.note}>
        {launchFailed ? (
          <b>
            Rien ne s’est lancé ? Une seule fois, démarre-le à la main : double-clique « Lancer le moteur » dans ton dossier
            MomentumBacktesterEngine. Ensuite, ce bouton suffira.
          </b>
        ) : launching ? (
          'La fenêtre noire du moteur s’ouvre : laisse-la ouverte, le site se connecte tout seul (jusqu’à ~20 s au premier démarrage).'
        ) : known ? (
          'Le navigateur demande la permission d’ouvrir le moteur : coche « Toujours autoriser » puis clique « Ouvrir ».'
        ) : (
          'Première fois : télécharge, décompresse, double-clique « Lancer le moteur » dans le dossier (Chrome / Edge demandent une fois l’accès aux appareils locaux : « Autoriser »). Ensuite, ce bouton suffit.'
        )}
      </span>
    </div>
  );
}
