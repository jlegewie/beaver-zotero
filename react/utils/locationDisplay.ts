import type { ContentKind } from '../types/citations';

function cleanLabel(label: string | null | undefined): string {
    return (label ?? '').trim();
}

function isSyntheticEpubSectionLabel(label: string): boolean {
    return /^section\s+\d+$/i.test(label);
}

export function explicitPageLabel(
    pageLabels: Record<number, string> | null | undefined,
    pageNumber: number,
): string {
    const label = pageLabels?.[pageNumber - 1];
    return cleanLabel(label);
}

export function formatLocationChip(
    contentKind: ContentKind | null | undefined,
    label: string | null | undefined,
): string {
    const cleaned = cleanLabel(label);
    if (!cleaned) return '';
    if (contentKind === 'epub' && isSyntheticEpubSectionLabel(cleaned)) return '';
    return `Page ${cleaned}`;
}
