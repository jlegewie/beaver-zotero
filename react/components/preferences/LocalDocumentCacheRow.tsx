import React, { useCallback, useEffect, useState } from 'react';
import { useAtomValue } from 'jotai';
import Button from '@beaver/agent-ui/primitives/Button';
import { hasOcrAccessAtom, hasSearchIndexAccessAtom } from '../../atoms/profile';
import { useSurfaceWindow } from '../../runtime/SurfaceWindowContext';
import { logger } from '@beaver/agent-core/platform/logger';
import type { DocumentCacheStats } from '../../../src/services/documentCache';
import { clearDocumentCache } from '../../../src/services/backgroundProcessing/resetLocalState';
import { SettingsRow } from './components/SettingsElements';
import { plural } from './processingStatusSentence';

/** Re-read cadence while the cache cannot be read, and once it can. */
const CACHE_STATS_RETRY_MS = 5_000;
const CACHE_STATS_REFRESH_MS = 30_000;

/** Format a byte count with one decimal in the largest fitting binary unit. */
export function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
    const units = ['bytes', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }
    return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

function describeCache(cache: DocumentCacheStats): string {
    const count = typeof cache.cached_document_count === 'number'
        ? `${plural(cache.cached_document_count, 'document')} cached · `
        : '';
    const budget = cache.payload_budget_bytes > 0 ? ` of ${formatBytes(cache.payload_budget_bytes)}` : '';
    return `${count}${formatBytes(cache.payload_total_bytes)}${budget}`;
}

/**
 * Size of the text Beaver extracted from attachments, with a Clear action.
 * Lives under Storage on the Advanced page beside the other data Beaver keeps
 * on this computer. Clearing is safe for the originals and for the server
 * search index; it costs a re-read on next use, and for scans another OCR
 * pass, which is why the action confirms first.
 */
const LocalDocumentCacheRow: React.FC<{ hasBorder?: boolean }> = ({ hasBorder = false }) => {
    const surfaceWindow = useSurfaceWindow();
    const hasOcrAccess = useAtomValue(hasOcrAccessAtom);
    const hasSearchAccess = useAtomValue(hasSearchIndexAccessAtom);
    const [cache, setCache] = useState<DocumentCacheStats | null | undefined>(undefined);
    const [clearing, setClearing] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const refresh = useCallback(async () => {
        try {
            setCache(await Zotero.Beaver?.documentCache?.getStats() ?? null);
        } catch (err) {
            logger(`LocalDocumentCacheRow: failed to read cache stats: ${err}`, 1);
            setCache(null);
        }
    }, []);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    // The cache service is attached late in startup and a read can fail
    // transiently, so keep re-reading while the row has nothing to show;
    // otherwise re-read slowly so the size tracks background processing. An
    // interval, not a timeout: a failed read leaves `cache` at null, which
    // would never re-trigger a state-keyed timeout.
    useEffect(() => {
        if (cache === undefined) return;
        const timer = surfaceWindow.setInterval(
            () => void refresh(),
            cache === null ? CACHE_STATS_RETRY_MS : CACHE_STATS_REFRESH_MS,
        );
        return () => surfaceWindow.clearInterval(timer);
    }, [cache, refresh, surfaceWindow]);

    const clear = useCallback(async () => {
        if (!cache) return;
        const notes = [
            'Your original files are not affected. Beaver reads a file again the next time it is needed.',
            hasOcrAccess ? 'Scanned files will need to be processed again.' : null,
            hasSearchAccess ? 'Your full-text search index is not affected.' : null,
        ].filter(Boolean).join(' ');
        const buttonIndex = Zotero.Prompt.confirm({
            window: surfaceWindow,
            title: 'Clear Local Document Cache?',
            text: `Delete the cached text for ${describeCache(cache)}?\n\n${notes}`,
            button0: 'Clear',
            // Cancel at button1 so Escape/dialog-close routes here.
            button1: Zotero.Prompt.BUTTON_TITLE_CANCEL,
            defaultButton: 1,
        });
        if (buttonIndex !== 0) return;
        setClearing(true);
        setError(null);
        try {
            await clearDocumentCache();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Could not clear the local cache.');
        } finally {
            await refresh();
            setClearing(false);
        }
    }, [cache, hasOcrAccess, hasSearchAccess, refresh, surfaceWindow]);

    return (
        <SettingsRow
            title="Local Document Cache"
            hasBorder={hasBorder}
            announceDescription
            description={
                <>
                    Text Beaver has read from your attachments, kept so it can respond faster.
                    <span className="display-flex mt-1">
                        {cache === undefined ? 'Checking local storage…' : cache === null ? 'Cache status unavailable' : describeCache(cache)}
                    </span>
                    {error && <span role="alert" className="display-flex font-color-red mt-1">{error}</span>}
                </>
            }
            control={
                <Button
                    variant="outline"
                    onClick={clear}
                    disabled={clearing || !cache}
                    loading={clearing}
                    style={{ padding: '4px 6px' }}
                >
                    Clear…
                </Button>
            }
        />
    );
};

export default LocalDocumentCacheRow;
