import React, { useEffect, useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { ExternalReference } from '../../types/externalReferences';
import {
    ArrowUpRightIcon,
    DownloadIcon,
    PdfIcon,
    InformationCircleIcon,
    Spinner,
} from '../icons/icons';
import { 
    isExternalReferenceDetailsDialogVisibleAtom, 
    selectedExternalReferenceAtom 
} from '../../atoms/ui';
import Button from '../ui/Button';
import { ExternalReferenceResult } from '../../types/chat/apiTypes';
import IconButton from '../ui/IconButton';
import Tooltip from '../ui/Tooltip';
import { ZOTERO_ICONS } from '../icons/ZoteroIcon';
import { ZoteroIcon } from '../icons/ZoteroIcon';
import { revealSource } from '../../utils/sourceUtils';
import { 
    checkExternalReferenceAtom, 
    getCachedReferenceForObjectAtom,
    isCheckingReferenceObjectAtom,
} from '../../atoms/externalReferences';

/** Display mode for action buttons */
export type ButtonDisplayMode = 'full' | 'icon-only' | 'none';

interface ActionButtonsProps {
    item: ExternalReference | ExternalReferenceResult;
    /** Display mode for the Reveal button (shown when item exists in library) */
    revealButtonMode?: ButtonDisplayMode;
    /** Display mode for the Import button (shown when item doesn't exist in library) */
    importButtonMode?: ButtonDisplayMode;
    /** Display mode for the Details button */
    detailsButtonMode?: ButtonDisplayMode;
    /** Display mode for the Web button */
    webButtonMode?: ButtonDisplayMode;
    /** Display mode for the PDF button */
    pdfButtonMode?: ButtonDisplayMode;
    /** Whether to show citation count */
    showCitationCount?: boolean;
}

const ActionButtons: React.FC<ActionButtonsProps> = ({
    item,
    revealButtonMode = 'full',
    importButtonMode = 'full',
    detailsButtonMode = 'full',
    webButtonMode = 'full',
    pdfButtonMode = 'icon-only',
    showCitationCount = true,
}) => {
    const setIsDetailsVisible = useSetAtom(isExternalReferenceDetailsDialogVisibleAtom);
    const setSelectedReference = useSetAtom(selectedExternalReferenceAtom);
    const checkReference = useSetAtom(checkExternalReferenceAtom);
    const getCachedReference = useAtomValue(getCachedReferenceForObjectAtom);
    const isChecking = useAtomValue(isCheckingReferenceObjectAtom);
    
    // Track the actual item existence state
    const [itemExists, setItemExists] = useState(item.library_items && item.library_items.length > 0);
    const [zoteroItemRef, setZoteroItemRef] = useState(
        item.library_items && item.library_items.length > 0
            ? { library_id: item.library_items[0].library_id, zotero_key: item.library_items[0].zotero_key }
            : null
    );
    const [isLoading, setIsLoading] = useState(false);
    const [bestAttachment, setBestAttachment] = useState<Zotero.Item | null>(null);
    
    // Check cache and validate on mount
    useEffect(() => {
        const refId = item.id;
        if (!refId) return;
        
        const cached = getCachedReference(item);
        
        // If we have cached data, use it
        if (cached !== undefined) {
            setItemExists(cached !== null);
            setZoteroItemRef(cached);
            
            // Check for best attachment if item exists
            if (cached !== null) {
                const zoteroItem = Zotero.Items.getByLibraryAndKey(cached.library_id, cached.zotero_key);
                if (zoteroItem && zoteroItem.isRegularItem()) {
                    zoteroItem.getBestAttachment().then(attachment => {
                        setBestAttachment(attachment || null);
                    });
                }
            }
            return;
        }
        
        // If not cached and not currently checking, start a check
        if (!isChecking(item)) {
            setIsLoading(true);
            checkReference(item).then(result => {
                setItemExists(result !== null);
                setZoteroItemRef(result);
                
                // Check for best attachment if item exists
                if (result !== null) {
                    const zoteroItem = Zotero.Items.getByLibraryAndKey(result.library_id, result.zotero_key);
                    if (zoteroItem && zoteroItem.isRegularItem()) {
                        zoteroItem.getBestAttachment().then(attachment => {
                            setBestAttachment(attachment || null);
                        });
                    }
                }
                setIsLoading(false);
            }).catch(() => {
                setIsLoading(false);
            });
        } else {
            setIsLoading(true);
        }
    }, [item, getCachedReference, checkReference, isChecking]);
    
    // Update loading state when checking state changes
    useEffect(() => {
        const checking = isChecking(item);
        if (checking) {
            setIsLoading(true);
        } else {
            // When checking completes, update from cache
            const cached = getCachedReference(item);
            if (cached !== undefined) {
                setItemExists(cached !== null);
                setZoteroItemRef(cached);
                setIsLoading(false);
                
                // Check for best attachment if item exists
                if (cached !== null) {
                    const zoteroItem = Zotero.Items.getByLibraryAndKey(cached.library_id, cached.zotero_key);
                    if (zoteroItem && zoteroItem.isRegularItem()) {
                        zoteroItem.getBestAttachment().then(attachment => {
                            setBestAttachment(attachment || null);
                        });
                    }
                }
            }
        }
    }, [isChecking(item), getCachedReference, item]);

    // Helper to render a button in different modes
    const renderButton = (
        mode: ButtonDisplayMode,
        tooltipContent: string,
        label: string,
        icon: React.ComponentType<{ className?: string }> | (() => React.ReactElement),
        onClick: () => void,
        disabled: boolean,
        ariaLabel?: string,
    ) => {
        if (mode === 'none') return null;
        
        if (mode === 'icon-only') {
            return (
                <Tooltip content={tooltipContent}>
                    <IconButton
                        variant="surface-light"
                        icon={icon}
                        className="font-color-secondary"
                        ariaLabel={ariaLabel || label}
                        onClick={onClick}
                        disabled={disabled}
                        style={{ padding: '3px 4px' }}
                    />
                </Tooltip>
            );
        }
        
        // mode === 'full'
        return (
            <Tooltip content={tooltipContent}>
                <Button
                    variant="surface-light"
                    icon={icon}
                    className="font-color-secondary truncate"
                    style={{ padding: '1px 4px' }}
                    onClick={onClick}
                    disabled={disabled}
                >
                    {label}
                </Button>
            </Tooltip>
        );
    };

    const hasPdf = item.open_access_url || (itemExists && zoteroItemRef && bestAttachment);

    return (
        <div className="display-flex flex-row items-center gap-3">
            {/* Reveal button - shown when item exists in library */}
            {itemExists && zoteroItemRef && renderButton(
                revealButtonMode,
                'Reveal in Zotero',
                'Reveal',
                isLoading ? () => <Spinner className="scale-14 -mr-1" /> : () => <ZoteroIcon icon={ZOTERO_ICONS.SHOW_ITEM} size={9} />,
                () => revealSource(zoteroItemRef),
                isLoading,
                'Reveal in Zotero'
            )}
            
            {/* Import button - shown when item doesn't exist in library */}
            {!itemExists && renderButton(
                importButtonMode,
                'Import to Zotero',
                'Import',
                isLoading ? () => <Spinner className="scale-14 -mr-1" /> : DownloadIcon,
                () => (item.publication_url || item.url) ? Zotero.launchURL(item.publication_url || item.url!) : undefined,
                (!item.publication_url && !item.url) || isLoading,
                'Import to Zotero'
            )}
            
            {/* Details button */}
            {renderButton(
                detailsButtonMode,
                'Open details',
                'Details',
                InformationCircleIcon,
                () => {
                    setSelectedReference(item);
                    setIsDetailsVisible(true);
                },
                !item.abstract,
                'Open details'
            )}
            
            {/* Web button */}
            {renderButton(
                webButtonMode,
                'Open website',
                'Web',
                ArrowUpRightIcon,
                () => (item.publication_url || item.url) ? Zotero.launchURL(item.url || item.publication_url!) : undefined,
                !item.publication_url && !item.url,
                'Open website'
            )}
            
            {/* PDF button - always rendered, disabled when no PDF available */}
            {renderButton(
                pdfButtonMode,
                hasPdf ? 'Open PDF' : 'No PDF available',
                'PDF',
                PdfIcon,
                () => {
                    if (bestAttachment) {
                        Zotero.getActiveZoteroPane().viewAttachment(bestAttachment.id);
                    } else if (item.open_access_url) {
                        Zotero.launchURL(item.open_access_url);
                    }
                },
                !hasPdf,
                'Open PDF'
            )}
            
            {/* Citation count */}
            {showCitationCount && (
                <div className="font-color-tertiary">Cited by {(item.citation_count || 0).toLocaleString()}</div>
            )}
        </div>
    );
};

export default ActionButtons;