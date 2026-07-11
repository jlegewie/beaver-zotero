/**
 * Mirrors the backend-computed cloud search-index entitlement into the
 * esbuild-readable `Zotero.Beaver.hasSearchIndexAccess` global, so the (esbuild)
 * background producers can gate `fulltext_upsert` enqueueing without importing
 * React/Jotai.
 */

import { useEffect } from 'react';
import { useAtomValue } from 'jotai';
import { hasSearchIndexAccessAtom } from '../atoms/profile';

export function useSearchIndexAccess(): void {
    const hasSearchIndexAccess = useAtomValue(hasSearchIndexAccessAtom);

    // Mirror the entitlement into the esbuild-readable global used by the
    // (future) enqueue gate.
    useEffect(() => {
        if (Zotero.Beaver) {
            (Zotero.Beaver as { hasSearchIndexAccess?: boolean }).hasSearchIndexAccess =
                hasSearchIndexAccess;
        }
        Zotero.Beaver?.processingReconciler?.notify();
    }, [hasSearchIndexAccess]);
}
