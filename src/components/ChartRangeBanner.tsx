'use client';

import { format } from 'date-fns';
import { fr } from 'date-fns/locale';
import type { MultiSeriesChartPoint } from '@/lib/chart-series';
import styles from './ChartRangeBanner.module.css';

interface Props {
  selectedStart: string;
  selectedEnd: string;
  data: MultiSeriesChartPoint[];
  loading?: boolean;
}

function fmtDate(d: string) {
  return format(new Date(d + 'T12:00:00'), 'd MMM yyyy', { locale: fr });
}

export default function ChartRangeBanner({
  selectedStart,
  selectedEnd,
  data,
  loading,
}: Props) {
  if (loading || !selectedStart || !selectedEnd) return null;

  const dataStart = data[0]?.date ?? null;
  const dataEnd = data[data.length - 1]?.date ?? null;

  if (!dataStart || !dataEnd) return null;

  const differsFromSelection =
    dataStart !== selectedStart || dataEnd !== selectedEnd;

  let note: string | null = null;
  if (differsFromSelection) {
    if (dataStart > selectedStart && dataEnd < selectedEnd) {
      note = 'Les données disponibles ne couvrent qu’une partie de la plage sélectionnée.';
    } else if (dataStart > selectedStart) {
      note = 'Le graphique commence plus tard : données insuffisantes ou alignement des courbes comparées avant cette date.';
    } else if (dataEnd < selectedEnd) {
      note = 'Le graphique se termine avant la fin de la plage sélectionnée (données manquantes).';
    } else if (dataStart < selectedStart) {
      note = 'Le graphique commence avant la plage sélectionnée (courbe de comparaison ou benchmark plus ancien).';
    }
  }

  return (
    <div className={styles.banner} role="status">
      <div className={styles.main}>
        <span className={styles.label}>Plage affichée</span>
        <span className={styles.dates}>
          {fmtDate(dataStart)} → {fmtDate(dataEnd)}
        </span>
        <span className={styles.points}>{data.length} points</span>
      </div>
      {differsFromSelection && (
        <div className={styles.secondary}>
          <span className={styles.labelMuted}>Plage sélectionnée</span>
          <span>{fmtDate(selectedStart)} → {fmtDate(selectedEnd)}</span>
        </div>
      )}
      {note && <p className={styles.note}>{note}</p>}
    </div>
  );
}
