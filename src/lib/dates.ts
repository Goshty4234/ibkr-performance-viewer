import { format } from 'date-fns';
import { fr } from 'date-fns/locale';

export function formatDateLabel(dateStr: string): string {
  try {
    return format(new Date(dateStr + 'T12:00:00'), 'd MMM yyyy', { locale: fr });
  } catch {
    return dateStr;
  }
}
