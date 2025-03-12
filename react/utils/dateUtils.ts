import { format, isToday, isYesterday, isThisWeek } from 'date-fns';

export function formatRelativeDate(date: Date) {
    if (isToday(date)) {
        return `Today at ${format(date, 'h.mma')}`;
    } else if (isYesterday(date)) {
        return `Yesterday at ${format(date, 'h.mma')}`;
    } else if (isThisWeek(date)) {
        return `${format(date, 'EEEE')} at ${format(date, 'h.mma')}`;
    } else {
        return format(date, 'MMM d, yyyy');
    }
}