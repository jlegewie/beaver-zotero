import React from 'react';
import { useSetAtom } from 'jotai';
import { ExternalReference } from '../../types/externalReferences';
import {
    ArrowUpRightIcon,
    DownloadIcon,
    PdfIcon,
} from '../icons/icons';
import { 
    isExternalReferenceDetailsDialogVisibleAtom, 
    selectedExternalReferenceAtom 
} from '../../atoms/ui';
import Button from '../ui/Button';
import { ExternalReferenceResult } from '../../types/chat/apiTypes';
import IconButton from '../ui/IconButton';
import Tooltip from '../ui/Tooltip';

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

    return (
        <div className="display-flex flex-row items-center gap-3">
            <Tooltip content="Import to Zotero">
                <Button
                    variant="surface-light"
                    icon={DownloadIcon}
                    className="font-color-secondary truncate"
                    onClick={() => (item.publication_url || item.url) ? Zotero.launchURL(item.publication_url || item.url!) : undefined}
                    disabled={!item.publication_url && !item.url}
                    style={{ padding: '1px 4px' }}
                >
                    Import
                </Button>
            </Tooltip>
            {showAbstractButton && (
                <Tooltip content="Open details">
                    <Button
                        variant="surface-light"
                        // icon={ArrowUpRightIcon}
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
            {item.open_access_url && (
                <Tooltip content="Open PDF">
                    <IconButton
                        variant="surface-light"
                        icon={PdfIcon}
                        className="font-color-secondary truncate"
                        iconClassName="icon-12"
                        ariaLabel="Open PDF"
                        onClick={() => item.open_access_url ? Zotero.launchURL(item.open_access_url!) : undefined}
                        disabled={!item.open_access_url}
                        style={{ padding: '3px 4px' }}
                    />
                </Tooltip>
            )}
            <div className="font-color-tertiary">Cited by {(item.citation_count || 0).toLocaleString()}</div>
        </div>
    );
};

export default ActionButtons;