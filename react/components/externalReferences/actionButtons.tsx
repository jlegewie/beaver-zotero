import React from 'react';
import { ExternalReference } from '../../types/externalReferences';
import {
    ArrowUpRightIcon,
    DownloadIcon,
} from '../icons/icons';
import Button from '../ui/Button';
import { ExternalReferenceResult } from '../../types/chat/apiTypes';

interface ActionButtonsProps {
    item: ExternalReference | ExternalReferenceResult;
}

const ActionButtons: React.FC<ActionButtonsProps> = ({
    item,
}) => {
    return (
        <div className="display-flex flex-row items-center gap-3">
            <Button
                variant="surface-light"
                // icon={ArrowUpRightIcon}
                className="font-color-secondary truncate"
                onClick={() => (item.publication_url || item.url) ? Zotero.launchURL(item.publication_url || item.url!) : undefined}
                disabled={!item.abstract}
                style={{ padding: '1px 4px' }}
            >
                Abstract
            </Button>
                                    <Button
                variant="surface-light"
                icon={ArrowUpRightIcon}
                className="font-color-secondary truncate"
                onClick={() => (item.publication_url || item.url) ? Zotero.launchURL(item.publication_url || item.url!) : undefined}
                disabled={!item.publication_url && !item.url}
                style={{ padding: '1px 4px' }}
            >
                Website
            </Button>                        
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
            <div className="font-color-tertiary">Cited by {(item.citation_count || 0).toLocaleString()}</div>
        </div>
    );
};

export default ActionButtons;