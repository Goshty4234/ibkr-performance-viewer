'use client';

import { engineOutdated } from '@/lib/engine/client';
import { useEngineStore } from '@/lib/engine/store';
import EngineUpdateButton, { engineStale } from './EngineUpdateButton';
import styles from './EngineSetup.module.css';

/** Banner shown when the engine cannot work with this site (too old, or without the storage folder)
 * or when a newer version is waiting for a restart. The action itself is the smart button. */
export default function EngineUpdate() {
  const engine = useEngineStore((s) => s.engine);
  const health = engine?.health;
  if (!engine || !health) return null;
  const outdated = engineOutdated(health);
  const stale = engineStale(engine);
  const ready = health.update?.state === 'ready';
  if (!outdated && !stale && !ready) return null;

  return (
    <div className={styles.box}>
      <span className={styles.title}>
        {outdated
          ? `Ton moteur (${health.version}) est trop ancien pour cette version du site.`
          : stale
            ? `Ton moteur (${health.version}) ne gère pas encore le dossier de stockage.`
            : `Nouvelle version du moteur prête (${health.update?.latest}).`}
      </span>
      <span className={styles.steps}><EngineUpdateButton /></span>
    </div>
  );
}
