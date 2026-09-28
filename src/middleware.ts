import { NextResponse, type NextRequest } from 'next/server';
import { updateSession } from '@/lib/supabase/middleware';

// NVIDIA Share (GeForce overlay) polls localhost:3000/socket.io several times a second. Each poll
// used to go through auth, get redirected to /login and render it: the dev server climbed to 13 GB.
const PROBES = /^\/(socket\.io|sockjs-node|ws)(\/|$)/;

export async function middleware(request: NextRequest) {
  if (PROBES.test(request.nextUrl.pathname)) return new NextResponse(null, { status: 404 });
  return updateSession(request);
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|login|auth|setup|api/setup|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
