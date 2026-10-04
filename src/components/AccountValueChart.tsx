'use client';

import { useMemo } from 'react';
import { format } from 'date-fns';
import { fr } from 'date-fns/locale';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { DailyNavPoint } from '@/lib/types';
import styles from './AccountExtras.module.css';

interface Props {
  points: DailyNavPoint[];
  rangeStart: string;
  rangeEnd: string;
  currency: string;
}

const COLORS = { stock: '#4d8dff', cash: '#4ade80', options: '#ffb020' };

function money(v: number, currency: string): string {
  return `${Math.round(v).toLocaleString('fr-CA')} ${currency === 'CAD' ? '$' : currency}`;
}

export default function AccountValueChart({ points, rangeStart, rangeEnd, currency }: Props) {
  const data = useMemo(
    () =>
      points
        .filter((p) => p.date >= rangeStart && p.date <= rangeEnd)
        .map((p) => {
          const hasParts = p.stock != null && p.cash != null;
          const options = hasParts ? Math.max(0, p.total - (p.stock ?? 0) - (p.cash ?? 0)) : 0;
          return {
            date: p.date,
            total: p.total,
            stock: hasParts ? p.stock ?? 0 : p.total,
            cash: hasParts ? p.cash ?? 0 : 0,
            options,
          };
        }),
    [points, rangeStart, rangeEnd],
  );

  if (data.length < 2) return null;
  const last = data[data.length - 1];
  const hasParts = points.some((p) => p.stock != null && p.cash != null);
  const share = (v: number) => (last.total > 0 ? ((v / last.total) * 100).toFixed(1) : '0.0');

  return (
    <div className={styles.card}>
      <div className={styles.title}>Valeur du compte</div>
      <div className={styles.sub}>
        Valeur totale du compte jour par jour (dépôts et retraits inclus : ce graphique montre l’argent réel,
        pas le rendement).{hasParts ? ' Répartition entre actions et cash.' : ''} Le détail par titre demande la section
        Open Positions ou Trades dans la Flex Query.
      </div>
      <div className={styles.chart}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" vertical={false} />
            <XAxis
              dataKey="date"
              tickFormatter={(v: string) => format(new Date(v + 'T12:00:00'), 'MMM yy', { locale: fr })}
              stroke="#5c6d85"
              fontSize={11}
              tickLine={false}
              minTickGap={40}
            />
            <YAxis
              tickFormatter={(v: number) => `${Math.round(v / 1000)} k`}
              stroke="#5c6d85"
              fontSize={11}
              tickLine={false}
              axisLine={false}
              width={48}
            />
            <Tooltip
              content={({ active, payload, label }) => {
                if (!active || !payload?.length) return null;
                const row = payload[0].payload as (typeof data)[number];
                return (
                  <div className={styles.tip}>
                    <div>{format(new Date(String(label) + 'T12:00:00'), 'd MMM yyyy', { locale: fr })}</div>
                    <div><b>Total : {money(row.total, currency)}</b></div>
                    {hasParts && (
                      <>
                        <div>Actions : {money(row.stock, currency)}</div>
                        <div>Cash : {money(row.cash, currency)}</div>
                        {row.options > 1 && <div>Autres : {money(row.options, currency)}</div>}
                      </>
                    )}
                  </div>
                );
              }}
            />
            <Area type="monotone" dataKey="stock" stackId="v" stroke={COLORS.stock} fill={COLORS.stock} fillOpacity={0.35} isAnimationActive={false} />
            <Area type="monotone" dataKey="cash" stackId="v" stroke={COLORS.cash} fill={COLORS.cash} fillOpacity={0.35} isAnimationActive={false} />
            <Area type="monotone" dataKey="options" stackId="v" stroke={COLORS.options} fill={COLORS.options} fillOpacity={0.35} isAnimationActive={false} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      {hasParts && (
        <div className={styles.legend}>
          <span><i className={styles.dot} style={{ background: COLORS.stock }} />Actions {share(last.stock)} %</span>
          <span><i className={styles.dot} style={{ background: COLORS.cash }} />Cash {share(last.cash)} %</span>
          {last.options > 1 && (
            <span><i className={styles.dot} style={{ background: COLORS.options }} />Autres {share(last.options)} %</span>
          )}
          <span>Total {money(last.total, currency)}</span>
        </div>
      )}
    </div>
  );
}
