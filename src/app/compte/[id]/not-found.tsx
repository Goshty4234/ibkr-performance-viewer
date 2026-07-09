import Link from 'next/link';
import AppShell from '@/components/AppShell';
import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';

export default async function NotFoundCompte() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  return (
    <AppShell email={user.email}>
      <div style={{ padding: '2rem', textAlign: 'center' }}>
        <h1 style={{ fontSize: '1.5rem', marginBottom: '0.5rem' }}>Compte introuvable</h1>
        <p style={{ color: 'var(--text-muted)', marginBottom: '1.5rem' }}>
          Ce compte n&apos;existe pas ou a été supprimé.
        </p>
        <Link href="/" className="btn btn-primary">← Retour au tableau de bord</Link>
      </div>
    </AppShell>
  );
}
