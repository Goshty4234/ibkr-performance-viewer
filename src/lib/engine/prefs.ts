import { isGuest } from '@/lib/guest';
import { createClient } from '@/lib/supabase/client';

/**
 * Where backtests run.
 *  - auto:  this PC when the local engine answers, otherwise the cloud engine
 *  - local: only this PC
 *  - cloud: only the cloud engine (URL editable at any time, provider-agnostic)
 */
export type EngineMode = 'auto' | 'local' | 'cloud';

export interface EnginePrefs {
  mode: EngineMode;
  cloudUrl: string;
  localUrl: string;
}

const STORAGE_KEY = 'engine-prefs-v1';

export const DEFAULT_LOCAL_URL = process.env.NEXT_PUBLIC_ENGINE_LOCAL_URL || 'http://127.0.0.1:8765';
export const DEFAULT_CLOUD_URL = process.env.NEXT_PUBLIC_ENGINE_CLOUD_URL || '';
/** Portable Windows engine: the latest GitHub release always carries this asset name. */
export const ENGINE_DOWNLOAD_URL = process.env.NEXT_PUBLIC_ENGINE_DOWNLOAD_URL
  || 'https://github.com/Goshty4234/ibkr-performance-viewer/releases/latest/download/MomentumBacktesterEngine-win64.zip';

export function normalizeUrl(url: string): string {
  const u = url.trim().replace(/\/+$/, '');
  if (!u) return '';
  return /^https?:\/\//i.test(u) ? u : `https://${u}`;
}

export function defaultPrefs(): EnginePrefs {
  return { mode: 'auto', cloudUrl: DEFAULT_CLOUD_URL, localUrl: DEFAULT_LOCAL_URL };
}

export function loadLocalPrefs(): EnginePrefs {
  if (typeof window === 'undefined') return defaultPrefs();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultPrefs();
    const p = JSON.parse(raw) as Partial<EnginePrefs>;
    return {
      mode: p.mode === 'local' || p.mode === 'cloud' ? p.mode : 'auto',
      cloudUrl: typeof p.cloudUrl === 'string' ? p.cloudUrl : DEFAULT_CLOUD_URL,
      localUrl: typeof p.localUrl === 'string' && p.localUrl ? p.localUrl : DEFAULT_LOCAL_URL,
    };
  } catch {
    return defaultPrefs();
  }
}

export function saveLocalPrefs(prefs: EnginePrefs): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    /* private mode */
  }
}

/** Account-level copy so every device knows the current cloud URL. */
export async function loadRemotePrefs(): Promise<Partial<EnginePrefs> | null> {
  if (isGuest()) return null;
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data } = await supabase
    .from('user_settings')
    .select('engine_preference, engine_cloud_url')
    .eq('user_id', user.id)
    .maybeSingle();
  if (!data) return null;
  const mode = data.engine_preference;
  return {
    mode: mode === 'local' || mode === 'cloud' || mode === 'auto' ? mode : undefined,
    cloudUrl: typeof data.engine_cloud_url === 'string' ? data.engine_cloud_url : undefined,
  };
}

export async function saveRemotePrefs(prefs: EnginePrefs): Promise<void> {
  if (isGuest()) return;
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;
  await supabase.from('user_settings').upsert(
    {
      user_id: user.id,
      engine_preference: prefs.mode,
      engine_cloud_url: prefs.cloudUrl,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id' },
  );
}
