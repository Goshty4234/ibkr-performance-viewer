'use client';

import { useEngineStore } from '@/lib/engine/store';
import styles from './EngineSetup.module.css';

/** Shown while the page looks for the engine, or waits for one that went quiet (busy, restarting).
 * The "no engine, download it" box only appears once that wait is really over. */
export default function EngineWait() {
  const reconnecting = useEngineStore((s) => s.reconnecting);
  const restarting = useEngineStore((s) => s.restarting);
  // During an update restart the update button already says it.
  if (restarting) return null;
  return (
    <span className={styles.wait} role="status">
      <span className={styles.spin} aria-hidden />
      {reconnecting ? 'Reconnexion au moteur… (il est occupé ou redémarre, quelques secondes)' : 'Recherche du moteur…'}
    </span>
  );
}
