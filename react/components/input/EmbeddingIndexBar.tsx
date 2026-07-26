import React, { useCallback } from 'react';
import { useAtomValue } from 'jotai';
import { SearchIcon } from '../icons/icons';
import { embeddingIndexStateAtom } from '../../atoms/embeddingIndex';
import { openPreferencesWindow } from '../../../src/ui/openPreferencesWindow';

/**
 * Persistent status bar shown below the input area while the local embedding
 * search index is being built. Clicking opens preferences on the Search tab.
 */
const EmbeddingIndexBar: React.FC = () => {
    const { status, phase, progress, totalItems, indexedItems } = useAtomValue(embeddingIndexStateAtom);

    const handleClick = useCallback(() => {
        openPreferencesWindow('sync');
    }, []);

    const visible =
        status === 'indexing' &&
        phase === 'initial' &&
        totalItems > 0;

    if (!visible) return null;

    const pct = Math.max(0, Math.min(100, progress));
    const label = `${pct.toFixed(0)}% (${indexedItems.toLocaleString()}/${totalItems.toLocaleString()} items)`;

    return (
        <div className="flex-none px-2 pb-1 -mt-3 ml-1">
            <div
                className="embedding-index-bar display-flex flex-row items-center gap-1 cursor-pointer transition-colors"
                onClick={handleClick}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') handleClick(); }}
            >
                <SearchIcon
                    width="1em"
                    height="1em"
                    color="currentColor"
                    pathStrokeWidth={0.85}
                    className="inline-block align-middle embedding-index-bar-icon font-color-secondary scale-90 transition-colors"
                    style={{ flexShrink: 0 }}
                />
                <div className="embedding-index-bar-text font-color-secondary text-sm flex-1 min-w-0 truncate transition-colors">
                    <div className="display-flex flex-row items-center gap-3">
                        <div className="font-color-secondary text-sm font-semibold">Building Search Index</div>
                        <div className="font-color-secondary text-sm">{label}</div>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default EmbeddingIndexBar;
