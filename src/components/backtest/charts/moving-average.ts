export type MaType = 'SMA' | 'EMA';

export function movingAverage(close: number[], window: number, type: MaType): (number | null)[] {
  const out: (number | null)[] = new Array(close.length).fill(null);
  if (window < 1) return out;
  if (type === 'SMA') {
    let s = 0;
    for (let i = 0; i < close.length; i++) {
      s += close[i];
      if (i >= window) s -= close[i - window];
      if (i >= window - 1) out[i] = s / window;
    }
  } else {
    const a = 2 / (window + 1);
    let e = close[0];
    for (let i = 0; i < close.length; i++) {
      e = i === 0 ? close[0] : a * close[i] + (1 - a) * e;
      if (i >= window - 1) out[i] = e;
    }
  }
  return out;
}
