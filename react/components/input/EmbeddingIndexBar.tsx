import React, { useCallback } from 'react';
import { useAtomValue } from 'jotai';
import { SearchIcon } from '../icons/icons';
import { isBackgroundWorkerRunningAtom } from '../../atoms/backgroundExtraction';
import { backgroundProcessingStatusAtom } from '../../atoms/backgroundProcessing';
import { hasOcrAccessAtom, hasSearchIndexAccessAtom } from '../../atoms/profile';
import { getPref } from '../../../src/utils/prefs';
import { openPreferencesWindow } from '../../../src/ui/openPreferencesWindow';

/** Compact whole-library processing indicator; kept under the legacy filename. */
const EmbeddingIndexBar: React.FC = () => {
    const isRunning = useAtomValue(isBackgroundWorkerRunningAtom);
    const status = useAtomValue(backgroundProcessingStatusAtom);
    const hasOcrAccess = useAtomValue(hasOcrAccessAtom);
    const hasSearchAccess = useAtomValue(hasSearchIndexAccessAtom);

    const handleClick = useCallback(() => openPreferencesWindow('sync'), []);
    const enabled = getPref('backgroundProcessingEnabled') === true;
    const visible = enabled
        && (hasOcrAccess || hasSearchAccess)
        && (isRunning || status.queue.pending > 0);
    if (!visible) return null;

    const count = Math.max(1, status.queue.pending);
    const label = `Processing ${count.toLocaleString()} document${count === 1 ? '' : 's'}…`;
    return (
        <div className="flex-none px-2 pb-1 -mt-3 ml-1">
            <div
                className="embedding-index-bar display-flex flex-row items-center gap-1 cursor-pointer transition-colors"
                onClick={handleClick}
                role="button"
                tabIndex={0}
                onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') handleClick();
                }}
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
                    <div className="font-color-secondary text-sm font-semibold">{label}</div>
                </div>
            </div>
        </div>
    );
};

export default EmbeddingIndexBar;
