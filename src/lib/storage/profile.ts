'use client';

import { create } from 'zustand';
import { isGuest } from '@/lib/guest';
import { createClient } from '@/lib/supabase/client';

/**
 * What this account may keep online, as decided by the administrator (database function
 * my_storage_profile). While that function does not exist yet, the app falls back to the
 * previous rule: the owner e-mail is "full", everybody else "lean".
 */
export type Tier = 'lean' | 'full';
export type ResultSource = 'auto' | 'local' | 'cloud';

export interface StorageProfile {
  userId: string;
  email: string | null;
  isAdmin: boolean;
  tier: Tier;
  /** Online results quota in bytes; null = unlimited. */
  quotaBytes: number | null;
  usedBytes: number;
  dbBytes: number;
  runs: number;
  configs: number;
  /** false = fallback profile (database functions missing). */
  managed: boolean;
}

/** Fallback rule only. The administrator is otherwise whoever the database says. */
const OWNER_EMAILS = (process.env.NEXT_PUBLIC_OWNER_EMAILS ?? 'voilanicolas@gmail.com')
  .split(',')
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

export const FALLBACK_LEAN_QUOTA = 25_000_000;

/** Caps applied to a lean account: the summary (curves + stats) and each detail chunk, compressed. */
export const LEAN_SUMMARY_MAX = 1_500_000;
export const LEAN_DETAIL_MAX = 150_000;

interface RpcProfile {
  is_admin: boolean;
  tier: Tier;
  quota_bytes: number | null;
  used_bytes: number;
  db_bytes: number;
  runs: number;
  configs: number;
}

export async function fetchProfile(): Promise<StorageProfile | null> {
  if (isGuest()) return null;
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const email = user.email ?? null;
  const { data, error } = await supabase.rpc('my_storage_profile');
  if (error || !data) {
    const owner = !!email && OWNER_EMAILS.includes(email.toLowerCase());
    return {
      userId: user.id, email, isAdmin: owner, tier: owner ? 'full' : 'lean',
      quotaBytes: owner ? null : FALLBACK_LEAN_QUOTA, usedBytes: 0, dbBytes: 0, runs: 0, configs: 0, managed: false,
    };
  }
  const p = data as RpcProfile;
  return {
    userId: user.id, email, isAdmin: !!p.is_admin, tier: p.tier === 'full' ? 'full' : 'lean',
    quotaBytes: p.quota_bytes === null || p.quota_bytes === undefined ? null : Number(p.quota_bytes),
    usedBytes: Number(p.used_bytes) || 0, dbBytes: Number(p.db_bytes) || 0,
    runs: Number(p.runs) || 0, configs: Number(p.configs) || 0, managed: true,
  };
}

interface ProfileState {
  profile: StorageProfile | null;
  loaded: boolean;
  refresh: () => Promise<StorageProfile | null>;
}

let inflight: Promise<StorageProfile | null> | null = null;

export const useStorageProfile = create<ProfileState>((set) => ({
  profile: null,
  loaded: false,
  refresh() {
    if (!inflight) {
      inflight = fetchProfile()
        .catch(() => null)
        .then((p) => {
          set({ profile: p, loaded: true });
          return p;
        })
        .finally(() => {
          inflight = null;
        });
    }
    return inflight;
  },
}));

let stamp = 0;

/** The profile, loaded once on first use (a few seconds old at most when a run is saved). */
export async function getProfile(maxAgeMs = 60_000): Promise<StorageProfile | null> {
  const s = useStorageProfile.getState();
  if (s.profile && Date.now() - stamp < maxAgeMs) return s.profile;
  const p = await s.refresh();
  stamp = Date.now();
  return p;
}

// ---- where results are read from (this device only) ----------------------------------------------

const SOURCE_KEY = 'results-source';

export function getResultSource(profile: StorageProfile | null): ResultSource {
  if (!profile || (profile.tier !== 'full' && !profile.isAdmin)) return 'auto';
  try {
    const v = window.localStorage.getItem(SOURCE_KEY);
    return v === 'local' || v === 'cloud' ? v : 'auto';
  } catch {
    return 'auto';
  }
}

export function setResultSource(v: ResultSource): void {
  try {
    window.localStorage.setItem(SOURCE_KEY, v);
  } catch {
    /* private mode */
  }
}
