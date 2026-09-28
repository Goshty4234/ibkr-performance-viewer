import { requireUser } from '@/lib/supabase/current-user';
import SettingsForm from './SettingsForm';

export default async function SettingsPage() {
  const { user } = await requireUser();
  return <SettingsForm email={user.email ?? ''} />;
}
