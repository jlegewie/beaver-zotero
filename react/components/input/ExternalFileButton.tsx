import React, { forwardRef } from 'react';
import { CSSItemTypeIcon, CSSIcon, Icon } from "../icons/icons";
import { useRemoveContextMenu } from '../../hooks/useRemoveContextMenu';
import { MenuItem } from '../ui/menu/ContextMenu';
import { truncateText } from '../../utils/stringUtils';
import { FileViewIcon, ExternalLinkIcon } from '../icons/icons';
import type { ExternalFileContentKind } from '../../types/attachments/apiTypes';
import { logger } from '../../../src/utils/logger';

const MAX_FILENAME_LENGTH = 25;

export const EXTERNAL_FILE_ICON_BY_KIND: Record<ExternalFileContentKind, string> = {
    pdf: 'attachmentPDF',
    epub: 'attachmentEPUB',
    text: 'attachmentFile',
    image: 'attachmentImage',
};

interface ExternalFileButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'> {
    /** External file key (8 characters, without the `ext-` prefix). */
    extKey: string;
    filename: string;
    contentKind: ExternalFileContentKind;
    /** Path of the managed copy; enables the "Show File" action when set. */
    storedPath?: string | null;
    canEdit?: boolean;
    disabled?: boolean;
    onRemove?: (extKey: string) => void;
    /** Remove all editable context at once (long-press menu on the "x"). */
    onRemoveAll?: () => void;
}

/**
 * Button chip for an external file (a file from disk, not a Zotero item)
 * attached to a message. Rendered both in the input area (removable) and in
 * sent messages (display-only, fed from the persisted attachment metadata).
 */
export const ExternalFileButton = forwardRef<HTMLButtonElement, ExternalFileButtonProps>(
    function ExternalFileButton(props: ExternalFileButtonProps, ref: React.ForwardedRef<HTMLButtonElement>) {
        const {
            extKey,
            filename,
            contentKind,
            storedPath,
            className,
            disabled = false,
            canEdit = true,
            onRemove,
            onRemoveAll,
            ...rest
        } = props;

        const [isHovered, setIsHovered] = React.useState(false);

        const showFile = () => {
            // Persisted chips (sent messages) carry no storedPath prop; fall
            // back to the local registry so the file can still be revealed on
            // this device. Rejections (e.g. a deleted copy) go to the logger
            // instead of an unhandled promise rejection — Zotero.File.reveal
            // is async.
            Promise.resolve()
                .then(async () => {
                    let path = storedPath ?? null;
                    if (!path) {
                        const record = await Zotero.Beaver?.db?.getExternalFileByKey(extKey);
                        path = record?.storedPath ?? null;
                    }
                    if (!path || !(await IOUtils.exists(path).catch(() => false))) {
                        logger(`ExternalFileButton: no local copy for ext-${extKey}`, 2);
                        return;
                    }
                    await Zotero.File.reveal(path);
                })
                .catch((error) => {
                    logger(`ExternalFileButton: Failed to reveal file: ${error}`, 2);
                });
        };

        // Always offered: showFile resolves the registry on demand and quietly
        // no-ops when the copy is unavailable on this device.
        const revealMenuItems: MenuItem[] = [
            { label: 'Show File', icon: FileViewIcon, onClick: showFile },
        ];

        const { isRemoveMenuOpen, contextMenuHandlers, removeHandlers, removeMenu } = useRemoveContextMenu({
            onRemove: () => {
                if (onRemove) onRemove(extKey);
            },
            onRemoveAll,
            canEdit,
            disabled,
            extraMenuItems: revealMenuItems,
        });

        const getIconElement = () => {
            if ((isHovered || isRemoveMenuOpen) && canEdit && !disabled) {
                return (
                    <span role="button" className="source-remove" {...removeHandlers}>
                        <CSSIcon name="x-8" className="icon-16" />
                    </span>
                );
            }
            return (
                <span className="scale-80">
                    <CSSItemTypeIcon itemType={EXTERNAL_FILE_ICON_BY_KIND[contentKind] || 'attachmentFile'} />
                </span>
            );
        };

        return (
            <>
            <button
                ref={ref}
                style={{ height: '22px' }}
                title={filename}
                className={`variant-outline source-button ${className || ''} ${disabled ? 'disabled-but-styled' : ''}`}
                disabled={disabled}
                onMouseEnter={() => setIsHovered(true)}
                onMouseLeave={() => setIsHovered(false)}
                onClick={(e) => {
                    e.stopPropagation();
                    // Chrome documents dispatch click for non-primary buttons
                    // too; only a left-click reveals the file.
                    if (e.button !== 0) return;
                    showFile();
                }}
                {...contextMenuHandlers}
                {...rest}
            >
                {getIconElement()}
                <span className="truncate">
                    {truncateText(filename, MAX_FILENAME_LENGTH)}
                </span>
                <Icon icon={ExternalLinkIcon} className="scale-95" />
            </button>
            {removeMenu}
            </>
        );
    }
);

export default ExternalFileButton;
