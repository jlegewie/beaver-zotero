import React, { useCallback } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import Button from '@beaver/agent-ui/primitives/Button';
import { logger } from '@beaver/agent-core/platform/logger';
import {
    embeddingIndexStateAtom,
    forceReindexAtom,
    isEmbeddingIndexingAtom,
} from '../../atoms/embeddingIndex';
import { SettingsRow } from './components/SettingsElements';
import EmbeddingIndexProgress from '../pages/onboarding/EmbeddingIndexProgress';

/**
 * Manual rebuild of the local metadata search index. The index maintains
 * itself and failures surface on the Search & Files page, so this is a
 * troubleshooting control: something to try when search results look stale.
 */
const RebuildSearchIndexRow: React.FC<{ hasBorder?: boolean }> = ({ hasBorder = false }) => {
    const indexState = useAtomValue(embeddingIndexStateAtom);
    const isIndexing = useAtomValue(isEmbeddingIndexingAtom);
    const forceReindex = useSetAtom(forceReindexAtom);

    const rebuild = useCallback(() => {
        if (isIndexing) return;
        logger('RebuildSearchIndexRow: user-initiated search index rebuild');
        forceReindex();
    }, [isIndexing, forceReindex]);

    const progress = isIndexing && indexState.progress > 0 ? ` (${indexState.progress}%)` : '';

    return (
        <>
            <SettingsRow
                title="Rebuild Search Index"
                hasBorder={hasBorder}
                announceDescription
                description={
                    <>
                        Check that the local index used to search by title and abstract matches your Zotero libraries.
                        This happens automatically; run it by hand if search results look out of date.
                        {indexState.failedItems > 0 && (
                            <span className="display-flex font-color-yellow mt-1">
                                {indexState.failedItems.toLocaleString()} items failed to index
                            </span>
                        )}
                        {indexState.status === 'error' && indexState.error && (
                            <span className="display-flex font-color-red mt-1">
                                Error: {indexState.error}
                            </span>
                        )}
                    </>
                }
                control={
                    <Button
                        variant="outline"
                        onClick={rebuild}
                        disabled={isIndexing}
                        loading={isIndexing}
                        style={{ padding: '4px 6px' }}
                    >
                        {isIndexing ? `Indexing${progress}` : 'Rebuild'}
                    </Button>
                }
            />
            {isIndexing && indexState.phase === 'initial' && indexState.totalItems > 0 && (
                <EmbeddingIndexProgress />
            )}
        </>
    );
};

export default RebuildSearchIndexRow;
