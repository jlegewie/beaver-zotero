import { formatDistanceToNow } from 'date-fns';
import { convertUTCToLocal } from './dateUtils';

export function formatTimeAgo(utcDateString: string): string {
    const localDate = convertUTCToLocal(utcDateString);
    return formatDistanceToNow(localDate, { addSuffix: true });
}
