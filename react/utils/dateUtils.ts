import { format, isToday, isYesterday, isThisWeek, isThisMonth, parseISO } from 'date-fns';
import { toZonedTime } from 'date-fns-tz';

// Re-export date-fns functions
export { isToday, isYesterday, isThisWeek, isThisMonth };

/**
 * Converts a UTC date string to a local Date object
 * @param utcDateString - UTC date string (ISO format)
 * @returns Date object in local timezone
 */
export function convertUTCToLocal(dateString: string): Date {
    // Handle both ISO strings and other date formats
    let date: Date;
    try {
        date = parseISO(dateString);
        // Check if valid date was parsed
        if (isNaN(date.getTime())) {
            // Fallback to regular Date constructor
            date = new Date(dateString);
        }
    } catch (error) {
        // Fallback to regular Date constructor
        date = new Date(dateString);
    }

    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return toZonedTime(date, timeZone);
}

/**
 * Formats a date relative to the current time
 * @param date - Date object
 * @returns Formatted string
 */
export function formatRelativeDate(date: Date) {
    if (isToday(date)) {
        return `Today at ${format(date, 'h:mma')}`;
    } else if (isYesterday(date)) {
        return `Yesterday at ${format(date, 'h:mma')}`;
    } else if (isThisWeek(date)) {
        return `${format(date, 'EEEE')} at ${format(date, 'h:mma')}`;
    } else {
        return format(date, 'MMM d, yyyy');
    }
}

/**
 * Groups a thread based on its creation date
 * @param dateString - UTC date string
 * @returns The group name ('Today', 'Yesterday', etc.)
 */
export function getDateGroup(dateString: string): string {
    const date = convertUTCToLocal(dateString);
    
    if (isToday(date)) {
        return 'Today';
    } else if (isYesterday(date)) {
        return 'Yesterday';
    } else if (isThisWeek(date)) {
        return 'This Week';
    } else if (isThisMonth(date)) {
        return 'This Month';
    } else {
        return 'Older';
    }
}