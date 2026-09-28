'use client';

import { useEffect, useState } from 'react';
import styles from './Backtester.module.css';

interface NumProps {
  label?: string;
  value: number | undefined;
  onChange: (v: number) => void;
  step?: number;
  min?: number;
  max?: number;
  /** Displayed value = stored * scale (e.g. 100 for fractions shown as %). */
  scale?: number;
  suffix?: string;
  title?: string;
  className?: string;
}

function fmt(v: number | undefined, scale: number): string {
  if (v === undefined || v === null || !Number.isFinite(v)) return '';
  const x = v * scale;
  return String(Math.round(x * 1e6) / 1e6);
}

/** Numeric input that keeps the typed text while editing and commits valid numbers. */
export function NumInput({ value, onChange, step, min, max, scale = 1, suffix, title, className }: NumProps) {
  const [text, setText] = useState(fmt(value, scale));
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!focused) setText(fmt(value, scale));
  }, [value, scale, focused]);

  const input = (
    <input
      type="number"
      inputMode="decimal"
      value={text}
      step={step}
      min={min}
      max={max}
      title={title}
      className={className}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false);
        setText(fmt(value, scale));
      }}
      onChange={(e) => {
        setText(e.target.value);
        const n = Number(e.target.value.replace(',', '.'));
        if (e.target.value !== '' && Number.isFinite(n)) onChange(n / scale);
      }}
    />
  );
  if (!suffix) return input;
  return (
    <span className={styles.pctWrap}>
      {input}
      <span>{suffix}</span>
    </span>
  );
}

export function NumField(props: NumProps) {
  return (
    <label className={styles.field} title={props.title}>
      {props.label}
      <NumInput {...props} />
    </label>
  );
}

export function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      className={`${styles.toggle} ${on ? styles.toggleOn : ''}`}
      onClick={() => onChange(!on)}
    />
  );
}

export function Check({ checked, onChange, children, title }: {
  checked: boolean;
  onChange: (v: boolean) => void;
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <label className={styles.checkRow} title={title}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {children}
    </label>
  );
}

export function SelectField<T extends string>({ label, value, options, onChange, title }: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (v: T) => void;
  title?: string;
}) {
  return (
    <label className={styles.field} title={title}>
      {label}
      <select value={value} onChange={(e) => onChange(e.target.value as T)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </label>
  );
}

export function TextField({ label, value, onChange, placeholder, mono, title }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
  title?: string;
}) {
  return (
    <label className={styles.field} title={title}>
      {label}
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        style={mono ? { fontFamily: 'var(--mono)' } : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}
