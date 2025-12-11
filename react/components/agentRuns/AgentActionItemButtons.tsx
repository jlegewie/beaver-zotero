import React, { useEffect, useState, useCallback } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import {
    ArrowUpRightIcon,
    PdfIcon,
    InformationCircleIcon,
    Spinner,
    TickIcon,
    CancelIcon,
} from '../icons/icons';
import { 
    isExternalReferenceDetailsDialogVisibleAtom, 
    selectedExternalReferenceAtom 
} from '../../atoms/ui';
import Button from '../ui/Button';
import IconButton from '../ui/IconButton';
import Tooltip from '../ui/Tooltip';
import { ZOTERO_ICONS, ZoteroIcon } from '../icons/ZoteroIcon';
import { revealSource } from '../../utils/sourceUtils';
import { 
    checkExternalReferenceAtom, 
    getCachedReferenceForObjectAtom,
    isCheckingReferenceObjectAtom,
} from '../../atoms/externalReferences';
import { ButtonVariant } from '../ui/Button';
import { CreateItemAgentAction } from '../../agents/agentActions';
import { ZoteroItemReference } from '../../types/zotero';

const CITED_BY_URL = 'https://openalex.org/works?page=1&filter=cites:';

interface AgentActionItemButtonsProps {
    action: CreateItemAgentAction;
    isBusy: boolean;
    onApply: () => void;
    onReject: () => void;
    /** Callback when an existing library match is found for a pending item */
    onExistingMatch?: (itemRef: ZoteroItemReference) => void;
    /** Button variant */
    buttonVariant?: ButtonVariant;
    /** Button size */
    className?: string;
}

/**
 * Action buttons for agent action item creation.
 * Handles different states: pending, applied, rejected/undone, error.
 * 
 * For pending items, checks if item already exists in library:
 * - If exists: calls onExistingMatch callback for auto-acknowledge
 * - If not: shows Add button
 * 
 * For applied items: shows Reveal, Details, Web, PDF buttons
 * For rejected/undone: shows Add button
 */
const AgentActionItemButtons: React.FC<AgentActionItemButtonsProps> = ({
    action,
    isBusy,
    onApply,
    onReject,
    onExistingMatch,
    buttonVariant = 'surface-light',
    className = '',
}) => {
    const item = action.proposed_data.item;
    const setIsDetailsVisible = useSetAtom(isExternalReferenceDetailsDialogVisibleAtom);
    const setSelectedReference = useSetAtom(selectedExternalReferenceAtom);
    const checkReference = useSetAtom(checkExternalReferenceAtom);
    const getCachedReference = useAtomValue(getCachedReferenceForObjectAtom);
    const isChecking = useAtomValue(isCheckingReferenceObjectAtom);
    
    // Local state for library item reference
    const [existingItemRef, setExistingItemRef] = useState<ZoteroItemReference | null>(null);
    const [isCheckingLibrary, setIsCheckingLibrary] = useState(false);
    const [bestAttachment, setBestAttachment] = useState<Zotero.Item | null>(null);

    // Determine effective item reference based on action status
    const getEffectiveItemRef = useCallback((): ZoteroItemReference | null => {
        // If applied, use result_data
        if (action.status === 'applied' && action.result_data?.zotero_key) {
            return {
                library_id: action.result_data.library_id,
                zotero_key: action.result_data.zotero_key
            };
        }
        // Otherwise use existing library match if found
        return existingItemRef;
    }, [action.status, action.result_data, existingItemRef]);

    const effectiveItemRef = getEffectiveItemRef();

    /**
     * Check if item already exists in library when pending
     * If found, notify parent for auto-acknowledge
     */
    useEffect(() => {
        const checkExistingItem = async () => {
            // Only check for pending items
            if (action.status !== 'pending') return;
            
            const refId = item.source_id;
            if (!refId) return;
            
            // Check cache first
            const cached = getCachedReference(item);
            
            if (cached !== undefined) {
                // Already checked
                if (cached !== null) {
                    setExistingItemRef(cached);
                    // Notify parent for auto-acknowledge
                    if (onExistingMatch) {
                        onExistingMatch(cached);
                    }
                }
                return;
            }
            
            // Not cached, need to check
            if (!isChecking(item)) {
                setIsCheckingLibrary(true);
                try {
                    const result = await checkReference(item);
                    if (result) {
                        setExistingItemRef(result);
                        // Notify parent for auto-acknowledge
                        if (onExistingMatch) {
                            onExistingMatch(result);
                        }
                    }
                } finally {
                    setIsCheckingLibrary(false);
                }
            }
        };
        
        checkExistingItem();
    }, [action.status, item, getCachedReference, checkReference, isChecking, onExistingMatch]);

    // Fetch best attachment when we have an item reference
    useEffect(() => {
        const fetchAttachment = async () => {
            if (!effectiveItemRef) {
                setBestAttachment(null);
                return;
            }
            
            const zoteroItem = await Zotero.Items.getByLibraryAndKeyAsync(
                effectiveItemRef.library_id,
                effectiveItemRef.zotero_key
            );
            
            if (zoteroItem && zoteroItem.isRegularItem()) {
                const attachment = await zoteroItem.getBestAttachment();
                setBestAttachment(attachment || null);
            } else {
                setBestAttachment(null);
            }
        };
        
        fetchAttachment();
    }, [effectiveItemRef]);

    const handleShowDetails = useCallback(() => {
        setSelectedReference(item);
        setIsDetailsVisible(true);
    }, [item, setSelectedReference, setIsDetailsVisible]);

    const handleOpenWeb = useCallback(() => {
        const url = item.url || item.publication_url;
        if (url) {
            Zotero.launchURL(url);
        }
    }, [item]);

    const handleOpenPdf = useCallback(() => {
        if (bestAttachment) {
            Zotero.getActiveZoteroPane().viewAttachment(bestAttachment.id);
        } else if (item.open_access_url) {
            Zotero.launchURL(item.open_access_url);
        }
    }, [bestAttachment, item.open_access_url]);

    const handleReveal = useCallback(() => {
        if (effectiveItemRef) {
            revealSource(effectiveItemRef);
        }
    }, [effectiveItemRef]);

    const isLoading = isBusy || isCheckingLibrary || isChecking(item);
    const hasPdf = item.open_access_url || bestAttachment;
    const hasWeb = item.url || item.publication_url;
    const hasDetails = Boolean(item.abstract);

    // Determine which buttons to show based on status
    const showRevealButton = action.status === 'applied' || (action.status === 'pending' && existingItemRef);
    const showAddButton = (action.status === 'pending' && !existingItemRef && !isCheckingLibrary) 
        || action.status === 'rejected' 
        || action.status === 'undone';
    const showRejectButton = action.status === 'pending' && !existingItemRef;

    return (
        <div className="display-flex flex-row items-center gap-3 flex-wrap">

            {/* Details button */}
            <Tooltip content={`${hasDetails ? 'Show details' : 'No details available'}`} singleLine>
                <IconButton
                    variant={buttonVariant}
                    icon={InformationCircleIcon}
                    className={`font-color-secondary ${className}`}
                    iconClassName="scale-90"
                    ariaLabel="Show details"
                    onClick={handleShowDetails}
                    style={{ padding: '2px' }}
                />
            </Tooltip>

            {/* Web button */}
            {hasWeb && (
                <Tooltip content="Open website" singleLine>
                    <IconButton
                        variant={buttonVariant}
                        icon={ArrowUpRightIcon}
                        className={`font-color-secondary ${className}`}
                        ariaLabel="Open website"
                        onClick={handleOpenWeb}
                        style={{ padding: '2px' }}
                    />
                </Tooltip>
            )}

            {/* PDF button */}
            {hasPdf && (
                <Tooltip content="Open PDF" singleLine>
                    <IconButton
                        variant={buttonVariant}
                        icon={PdfIcon}
                        className={`font-color-secondary ${className}`}
                        ariaLabel="Open PDF"
                        onClick={handleOpenPdf}
                        style={{ padding: '2px' }}
                    />
                </Tooltip>
            )}

            {/* Citation count */}
            {item.citation_count !== undefined && item.citation_count > 0 && (
                <a
                    onClick={() => Zotero.launchURL(`${CITED_BY_URL}${item.source_id}`)}
                    className="text-link-muted text-sm"
                >
                    Cited by {item.citation_count.toLocaleString()}
                </a>
            )}
            {item.citation_count !== undefined && item.citation_count === 0 && (
                <div className="font-color-tertiary text-sm">
                    Cited by {item.citation_count.toLocaleString()}
                </div>
            )}

            <div className="flex-1"/>

            {isLoading && (
                <Spinner className="scale-12 -mr-1" />
            )}

            {/* Pending: Reject button */}
            {showRejectButton && !isLoading && (
                <Tooltip content="Reject Item" singleLine>
                    <IconButton
                        variant={buttonVariant}
                        icon={CancelIcon}
                        className={`font-color-secondary ${className}`}
                        iconClassName="scale-90"
                        ariaLabel="Reject Item"
                        onClick={onReject}
                        disabled={isLoading}
                        style={{ padding: '2px' }}
                    />
                </Tooltip>
            )}

            {/* Add button: shown for pending (no match), rejected, or undone */}
            {showAddButton && !isLoading && (
                <Tooltip content="Add to library" singleLine>
                    <IconButton
                        variant={buttonVariant}
                        icon={TickIcon}
                        iconClassName="scale-12"
                        className={`font-color-secondary ${className}`}
                        style={{ padding: '2px' }}
                        onClick={onApply}
                        ariaLabel="Add to library"
                        disabled={isLoading}
                    />
                </Tooltip>
            )}

            {/* Pending with existing match OR Applied: Reveal button */}
            {showRevealButton && !isLoading && (
                <Tooltip content={action.status === 'pending' ? 'Already in library - click to reveal' : 'Reveal in Zotero'} singleLine>
                    <Button
                        variant={buttonVariant}
                        rightIcon={() => <ZoteroIcon icon={ZOTERO_ICONS.SHOW_ITEM} size={9} />}
                        className={`font-color-secondary ${className}`}
                        style={{ padding: '1px 4px' }}
                        onClick={handleReveal}
                        disabled={isLoading}
                    >
                        {action.status === 'pending' ? 'In Library' : 'Reveal'}
                    </Button>
                </Tooltip>
            )}
        </div>
    );
};

export default AgentActionItemButtons;

