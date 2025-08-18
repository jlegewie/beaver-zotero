// function to truncate text to a max length
export const truncateText = (text: string, maxLength: number) => {
    if (text.length <= maxLength) return text;
    return text.slice(0, maxLength) + '...';
}


export function formatNumberRanges(numbers: number[]): string {
    if (numbers.length === 0) return "";

    // Sort and remove duplicates just in case
    const sorted = [...new Set(numbers)].sort((a, b) => a - b);

    const parts: string[] = [];
    let start = sorted[0];
    let prev = sorted[0];

    for (let i = 1; i <= sorted.length; i++) {
        const current = sorted[i];
        if (current === prev + 1) {
            // Still in a range, keep going
            prev = current;
        } else {
            // End of a range
            if (start === prev) {
                parts.push(`${start}`);
            } else {
                parts.push(`${start}-${prev}`);
            }
            // Start a new range
            start = current;
            prev = current;
        }
    }

    return parts.join(", ");
}
