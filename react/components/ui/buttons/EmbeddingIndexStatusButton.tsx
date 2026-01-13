import React, { useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { 
    embeddingIndexStateAtom, 
    forceReindexAtom,
    isEmbeddingIndexingAtom,
    hasEmbeddingIndexErrorAtom,
    hasFailedEmbeddingsAtom
} from "../../../atoms/embeddingIndex";
import IconButton from "../IconButton";
import { AlertIcon, SyncIcon } from "../../icons/icons";
import Tooltip from "../Tooltip";
import { logger } from "../../../../src/utils/logger";


/**
 * Button that shows embedding index status and allows manual reindex.
 * Similar to DatabaseStatusButton but for embedding/semantic search index.
 * 
 * Shows:
 * - Spinning icon when indexing
 * - Alert icon when there's an error or failed items
 * - Hidden when idle with no issues
 */
const EmbeddingIndexStatusButton: React.FC = () => {
    const [isHovered, setIsHovered] = useState(false);
    
    const indexState = useAtomValue(embeddingIndexStateAtom);
    const isIndexing = useAtomValue(isEmbeddingIndexingAtom);
    const hasError = useAtomValue(hasEmbeddingIndexErrorAtom);
    const hasFailedItems = useAtomValue(hasFailedEmbeddingsAtom);
    const forceReindex = useSetAtom(forceReindexAtom);
    
    // Handle manual reindex button click
    const handleReindexClick = () => {
        if (!isIndexing) {
            logger(`EmbeddingIndexStatusButton: User-initiated reindex`);
            forceReindex();
        }
    };
    
    // Only show when indexing, has error, or has failed items
    if (!isIndexing && !hasError && !hasFailedItems) return null;
    
    // Determine which icon to show
    const icon = isIndexing ? SyncIcon : (isHovered ? SyncIcon : AlertIcon);
    const iconClassName = isIndexing 
        ? "animate-spin" 
        : (isHovered ? "" : "font-color-red");
    
    // Build tooltip content
    let tooltipContent = "Rebuild Search Index";
    let secondaryContent: string | undefined;
    
    if (isIndexing) {
        const progress = indexState.progress > 0 ? ` (${indexState.progress}%)` : '';
        tooltipContent = `Indexing${progress}`;
    } else if (hasError) {
        tooltipContent = "Indexing Error";
        secondaryContent = indexState.error || "Click to retry";
    } else if (hasFailedItems) {
        tooltipContent = `${indexState.failedItems} items failed to index`;
        secondaryContent = "Click to retry indexing";
    }
    
    return (
        <Tooltip
            content={tooltipContent}
            secondaryContent={secondaryContent}
            showArrow
            singleLine
        >
            <div
                onMouseEnter={() => setIsHovered(true)}
                onMouseLeave={() => setIsHovered(false)}
            >
                <IconButton
                    icon={icon}
                    onClick={handleReindexClick}
                    className="scale-13"
                    iconClassName={iconClassName}
                    ariaLabel={isIndexing ? "Indexing..." : "Rebuild Search Index"}
                    disabled={isIndexing}
                />
            </div>
        </Tooltip>
    );
};

export default EmbeddingIndexStatusButton;

