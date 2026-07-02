/** Dev-only parity check for snapshot annotation selectors and sort indexes. */

import {
    resolveSnapshotAnnotationTarget,
} from '../../../src/services/annotations/snapshot/snapshotAnnotationResolver';
import { resolveSnapshotCitationRange } from '../../utils/snapshotVisualizer/snapshotRangeResolver';
import {
    annotationFromRange,
    getSnapshotBody,
    isSnapshotReadingModeEnabled,
    type SnapshotPrimaryView,
} from '../../utils/snapshotVisualizer/snapshotReaderView';
import {
    getCurrentReaderAndWaitForView,
    waitForReaderForItem,
} from '../../utils/readerUtils';

const PARITY_HIGHLIGHT_COLOR = '#ffd400';

async function openReaderForAttachment(item: Zotero.Item): Promise<any | undefined> {
    const current = await getCurrentReaderAndWaitForView(undefined, false);
    if (current?.itemID === item.id) return current;
    const opened = await Zotero.Reader.open(item.id);
    return waitForReaderForItem(item.id, opened);
}

interface ParityTargetInput {
    anchor_id?: string;
    text?: string;
}

/** Deterministic JSON with sorted keys, so position equality ignores key order. */
function stableStringify(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    const entries = Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`);
    return `{${entries.join(',')}}`;
}

export async function handleTestSnapshotAnnotationParityHttpRequest(request: any): Promise<any> {
    const { library_id, zotero_key, items } = request || {};
    if (library_id == null || zotero_key == null || !Array.isArray(items)) {
        return { ok: false, error: 'Provide library_id, zotero_key, items[]' };
    }

    const item = await Zotero.Items.getByLibraryAndKeyAsync(library_id, zotero_key);
    if (!item) return { ok: false, error: 'not_found' };
    const filePath = await item.getFilePathAsync();
    if (!filePath) return { ok: false, error: 'no_file' };

    const reader = await openReaderForAttachment(item);
    if (!reader) return { ok: false, error: 'no_reader' };
    if (reader.type !== 'snapshot') return { ok: false, error: 'not_a_snapshot_reader' };
    const primaryView = reader._internalReader?._primaryView as SnapshotPrimaryView | undefined;
    if (!primaryView) return { ok: false, error: 'no_primary_view' };
    const body = getSnapshotBody(primaryView);
    if (!body) return { ok: false, error: 'no_snapshot_body' };

    const readingMode = isSnapshotReadingModeEnabled(primaryView);

    const results: any[] = [];
    for (const raw of items as ParityTargetInput[]) {
        const target = {
            anchorId: typeof raw.anchor_id === 'string' ? raw.anchor_id : undefined,
            text: typeof raw.text === 'string' ? raw.text : undefined,
        };

        // Reader side: live range -> reader-generated annotation metadata.
        let readerPosition: unknown = null;
        let readerSortIndex: string | null = null;
        let readerText: string | null = null;
        const range = resolveSnapshotCitationRange(body, target);
        if (range) {
            readerText = range.toString();
            const annotation = annotationFromRange(primaryView, range, 'highlight', PARITY_HIGHLIGHT_COLOR);
            if (annotation) {
                readerPosition = annotation.position;
                readerSortIndex = annotation.sortIndex ?? null;
            }
        }

        // Headless side: HTML-only annotation metadata.
        const headless = await resolveSnapshotAnnotationTarget(filePath, target);
        const headlessOk = !('error' in headless);

        const positionMatch = readerPosition != null && headlessOk
            ? stableStringify(readerPosition) === stableStringify(headless.position)
            : null;
        const sortIndexMatch = readerSortIndex != null && headlessOk
            ? readerSortIndex === headless.sortIndex
            : null;

        results.push({
            target: raw,
            reader: range
                ? { position: readerPosition, sort_index: readerSortIndex, text: readerText }
                : { error: 'range_not_found' },
            headless: headlessOk
                ? { position: headless.position, sort_index: headless.sortIndex, text: headless.text }
                : { error: headless.error, message: (headless as any).message },
            position_match: positionMatch,
            sort_index_match: sortIndexMatch,
        });
    }

    return { ok: true, reading_mode: readingMode, results };
}
