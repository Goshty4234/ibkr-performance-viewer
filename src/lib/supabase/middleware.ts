import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { getUserResilient } from '@/lib/supabase/auth-resilient';
import { GUEST_COOKIE } from '@/lib/guest';

/** Guests (no account) only get the backtester and the public helpers it calls. */
function guestAllowed(path: string): boolean {
  return path === '/' || path.startsWith('/api/fx');
}

function guestResponse(request: NextRequest, path: string, pass: NextResponse): NextResponse {
  if (guestAllowed(path)) return pass;
  if (path.startsWith('/api/')) return NextResponse.json({ error: 'Mode invité : réservé aux comptes' }, { status: 401 });
  const home = request.nextUrl.clone();
  home.pathname = '/';
  home.search = '';
  return NextResponse.redirect(home);
}

type CookieToSet = { name: string; value: string; options: CookieOptions };

const PLACEHOLDER_URL = 'https://placeholder.supabase.co';
const PLACEHOLDER_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';

function hasAuthCookie(request: NextRequest): boolean {
  return request.cookies
    .getAll()
    .some((c) => c.name.startsWith('sb-') || c.name.includes('supabase-auth'));
}

export async function updateSession(request: NextRequest) {
  const path = request.nextUrl.pathname;

  const isPublic =
    path.startsWith('/login') ||
    path.startsWith('/auth') ||
    path.startsWith('/setup') ||
    path.startsWith('/api/setup');

  let supabaseResponse = NextResponse.next({ request });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || PLACEHOLDER_URL;
  const key =
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
    PLACEHOLDER_KEY;

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet: CookieToSet[]) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        supabaseResponse = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) =>
          supabaseResponse.cookies.set(name, value, options),
        );
      },
    },
  });

  const auth = await getUserResilient(supabase);
  const guest = request.cookies.get(GUEST_COOKIE)?.value === '1';

  if (auth.status === 'timeout') {
    if (hasAuthCookie(request)) return supabaseResponse;
    if (guest && !isPublic) return guestResponse(request, path, supabaseResponse);
    if (!isPublic) {
      if (path.startsWith('/api/')) {
        return NextResponse.json({ error: 'Non authentifié' }, { status: 401 });
      }
      const redirectUrl = request.nextUrl.clone();
      redirectUrl.pathname = '/login';
      redirectUrl.search = '';
      return NextResponse.redirect(redirectUrl);
    }
    return supabaseResponse;
  }

  const user = auth.user;

  if (!user && guest && !isPublic) return guestResponse(request, path, supabaseResponse);

  // Signed in: a leftover guest cookie would keep the browser in guest mode.
  if (user && guest) supabaseResponse.cookies.delete(GUEST_COOKIE);

  if (!user && !isPublic) {
    if (path.startsWith('/api/')) {
      return NextResponse.json({ error: 'Non authentifié' }, { status: 401 });
    }
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = '/login';
    redirectUrl.search = '';
    return NextResponse.redirect(redirectUrl);
  }

  if (user && path.startsWith('/login')) {
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = '/';
    redirectUrl.search = '';
    return NextResponse.redirect(redirectUrl);
  }

  return supabaseResponse;
}
