import React from 'react';
import { Icon, CancelIcon, BookmarkIcon } from '../icons';
import { InputSource } from '../../types/sources';
import { useSetAtom, useAtomValue } from 'jotai';
import { activePreviewAtom } from '../../atoms/ui';
import { currentSourcesAtom, togglePinSourceAtom, removeSourceAtom, readerItemKeyAtom } from '../../atoms/input';
import { ZoteroIcon, ZOTERO_ICONS } from '../icons/ZoteroIcon';
import { openPDFInNewWindow } from '../../utils/openPDFInNewWindow';
import SourcePreviewRegularItem from './SourcePreviewRegularItem';
import SourcePreviewAttachment from './SourcePreviewAttachment';
import { getCurrentPage } from '../../utils/readerUtils';
import { getZoteroItem } from '../../utils/sourceUtils';
import Button from '../button';
import IconButton from '../IconButton';

interface SourcePreviewContentProps {
    source: InputSource;
    maxContentHeight: number;
}

const SourcePreviewContent: React.FC<SourcePreviewContentProps> = ({ source, maxContentHeight }) => {
    const setActivePreview = useSetAtom(activePreviewAtom);
    const togglePinSource = useSetAtom(togglePinSourceAtom);
    const removeSource = useSetAtom(removeSourceAtom);
    const readerItemKey = useAtomValue(readerItemKeyAtom);

    // Get source from sources atom to ensure we have the latest data (e.g., pinned status)
    const currentSources = useAtomValue(currentSourcesAtom);
    const currentSource = currentSources.find(att => att.id === source.id) || source;

    const item = getZoteroItem(currentSource);
    if (!item) {
        // If item becomes invalid while preview is open, close preview
        setActivePreview(null); 
        return null;
    }
    const isRegularZoteroItem = item.isRegularItem();

    const handlePin = () => {
        togglePinSource(currentSource.id);
        setActivePreview(null);
    };

    const handleRemove = () => {
        removeSource(currentSource);
        setActivePreview(null);
    };

    const handleOpen = async () => {
        if (item.isNote()) {
            await Zotero.getActiveZoteroPane().openNoteWindow(item.id);
        } else {
            await openPDFInNewWindow(item);
        }
        setActivePreview(null);
    };

    // Determine if the PDF can be opened
    const canOpen =
        item.isPDFAttachment() ||
        (item.isRegularItem() && item.getAttachments().some(att => Zotero.Items.get(att).isPDFAttachment())) ||
        item.isNote();

    // Render appropriate content based on attachment type
    const renderContent = () => {
        if (!currentSource) return null;
        
        if (isRegularZoteroItem) {
            return <SourcePreviewRegularItem source={currentSource} item={item} />;
        } else if (item) {
            return <SourcePreviewAttachment source={currentSource} item={item} />;
        } else {
            return null;
        }
    };

    return (
        <>
            {/* Content Area */}
            <div 
                className="source-content p-3"
                style={{ maxHeight: `${maxContentHeight}px` }}
            >
                {renderContent()}
                {readerItemKey == source.itemKey &&
                    <div className="display-flex flex-row items-center gap-1 opacity-50">
                        <Icon icon={BookmarkIcon} className="scale-11" />
                        <span>Current Reader Item, page {getCurrentPage()}</span>
                    </div>
                }
            </div>

            {/* buttons */}
            <div className="px-1 pt-1 display-flex flex-row items-center">
                {readerItemKey != source.itemKey && (
                    <div className="gap-3 display-flex">
                        <Button
                            variant="ghost"
                            onClick={handlePin}
                        >
                            <ZoteroIcon 
                                icon={currentSource.pinned ? ZOTERO_ICONS.PIN_REMOVE : ZOTERO_ICONS.PIN} 
                                size={12}
                            />
                            <span>{currentSource.pinned ? 'Unpin' : 'Pin'}</span>
                        </Button>
                        <Button
                            variant="ghost"
                            onClick={handleOpen}
                            disabled={!canOpen}
                        >
                            <ZoteroIcon 
                                icon={ZOTERO_ICONS.OPEN} 
                                size={12}
                            />
                            Open
                        </Button>
                        <Button 
                            variant="ghost"
                            onClick={handleRemove}
                            disabled={readerItemKey == source.itemKey}
                        >
                            <ZoteroIcon 
                                icon={ZOTERO_ICONS.TRASH} 
                                size={12}
                            />
                            Remove
                        </Button>
                    </div>
                )}
                <div className="flex-1"/>
                <div className="display-flex">
                    <IconButton
                        icon={CancelIcon}
                        variant="ghost"
                        onClick={() => setActivePreview(null)}
                    />
                </div>
            </div>
        </>
    );
};

export default SourcePreviewContent; 