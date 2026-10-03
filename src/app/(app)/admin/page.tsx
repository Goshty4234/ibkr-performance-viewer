import { notFound } from 'next/navigation';
import { requireUser } from '@/lib/supabase/current-user';
import AdminPanel from '@/components/storage/AdminPanel';

// Until supabase/storage_admin.sql is installed the database cannot say who is an administrator:
// only the owner e-mail gets in, to be able to run it.
const OWNER_EMAILS = (process.env.NEXT_PUBLIC_OWNER_EMAILS ?? 'voilanicolas@gmail.com')
  .split(',')
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

export default async function AdminPage() {
  const { supabase, user } = await requireUser();
  const { data, error } = await supabase.rpc('is_admin');
  const allowed = error ? !!user.email && OWNER_EMAILS.includes(user.email.toLowerCase()) : data === true;
  if (!allowed) notFound();
  return <AdminPanel selfId={user.id} />;
}
