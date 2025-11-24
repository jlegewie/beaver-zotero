import React, { useEffect, useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { ExternalReference } from '../../types/externalReferences';
import {
    ArrowUpRightIcon,
    DownloadIcon,
    PdfIcon,
    InformationCircleIcon
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
import { SpinnerIcon } from '../status/icons';

interface ActionButtonsProps {
    item: ExternalReference | ExternalReferenceResult;
    showAbstractButton?: boolean;
}

const ActionButtons: React.FC<ActionButtonsProps> = ({
    item,
    showAbstractButton = true,
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

    return (
        <div className="display-flex flex-row items-center gap-3">
            {itemExists && zoteroItemRef && (
                <Tooltip content="Reveal in Zotero">
                    <Button
                        variant="surface-light"
                        icon={isLoading ? SpinnerIcon : () => <ZoteroIcon icon={ZOTERO_ICONS.SHOW_ITEM} size={9} />}
                        className="font-color-secondary truncate"
                        style={{ padding: '1px 4px' }}
                        onClick={() => revealSource(zoteroItemRef)}
                        disabled={isLoading}
                    >
                        Reveal
                    </Button>
                </Tooltip>
            )}
            {!itemExists && (
                <Tooltip content="Import to Zotero">
                    <Button
                        variant="surface-light"
                        icon={isLoading ? SpinnerIcon : DownloadIcon}
                        className="font-color-secondary truncate"
                        onClick={() => (item.publication_url || item.url) ? Zotero.launchURL(item.publication_url || item.url!) : undefined}
                        disabled={(!item.publication_url && !item.url) || isLoading}
                        style={{ padding: '1px 4px' }}
                    >
                        Import
                    </Button>
                </Tooltip>
            )}
            {showAbstractButton && (
                <Tooltip content="Open details">
                    <Button
                        variant="surface-light"
                        icon={InformationCircleIcon}
                        className="font-color-secondary truncate"
                        onClick={() => {
                            setSelectedReference(item);
                            setIsDetailsVisible(true);
                        }}
                        disabled={!item.abstract}
                        style={{ padding: '1px 4px' }}
                    >
                        Details
                    </Button>
                </Tooltip>
            )}
            <Tooltip content="Open website">
                <Button
                    variant="surface-light"
                    icon={ArrowUpRightIcon}
                    className="font-color-secondary truncate"
                    onClick={() => (item.publication_url || item.url) ? Zotero.launchURL(item.url || item.publication_url!) : undefined}
                    disabled={!item.publication_url && !item.url}
                    style={{ padding: '1px 4px' }}
                >
                    Web
                </Button>
            </Tooltip>
            {/* <Tooltip content="Open website">
                <IconButton
                    variant="surface-light"
                    icon={ArrowUpRightIcon}
                    className="font-color-secondary truncate"
                    onClick={() => (item.publication_url || item.url) ? Zotero.launchURL(item.url || item.publication_url!) : undefined}
                    disabled={!item.publication_url && !item.url}
                    style={{ padding: '3px 4px' }}
                />
            </Tooltip> */}
            {(item.open_access_url || (itemExists && zoteroItemRef && bestAttachment)) && (
                <Tooltip content="Open PDF">
                    <IconButton
                        variant="surface-light"
                        icon={PdfIcon}
                        className="font-color-secondary truncate"
                        iconClassName="scale-11"
                        ariaLabel="Open PDF"
                        onClick={() => {
                            if (bestAttachment) {
                                Zotero.getActiveZoteroPane().viewAttachment(bestAttachment.id);
                            } else if (item.open_access_url) {
                                Zotero.launchURL(item.open_access_url);
                            }
                        }}
                        disabled={!item.open_access_url && !bestAttachment}
                        style={{ padding: '3px 4px' }}
                    />
                </Tooltip>
            )}
            <div className="font-color-tertiary">Cited by {(item.citation_count || 0).toLocaleString()}</div>
        </div>
    );
};

export default ActionButtons;