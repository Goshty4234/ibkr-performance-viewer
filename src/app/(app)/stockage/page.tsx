import { requireUser } from '@/lib/supabase/current-user';
import StoragePanel from '@/components/storage/StoragePanel';

export default async function StoragePage() {
  await requireUser();
  return <StoragePanel />;
}
