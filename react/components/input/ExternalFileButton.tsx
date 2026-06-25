import React, { forwardRef } from 'react';
import { CSSItemTypeIcon, CSSIcon, Icon } from "../icons/icons";
import { useRemoveContextMenu } from '../../hooks/useRemoveContextMenu';
import { MenuItem } from '../ui/menu/ContextMenu';
import { truncateText } from '../../utils/stringUtils';
import { FileViewIcon, ExternalLinkIcon } from '../icons/icons';
import type { ExternalFileContentKind } from '../../types/attachments/apiTypes';
import { logger } from '../../../src/utils/logger';
import { ChipWithPopup, type ChipPopupContent } from '../agentRuns/requestChips/ChipPopup';
import { ChipButton } from '../agentRuns/requestChips/ChipButton';
import { ChipRemovableIcon } from '../agentRuns/requestChips/ChipRemovableIcon';
import { getHost } from '../../host';

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

        // Primary click opens the file in its default app, matching the
        // read-only request chips. Routed through the host so the "no local
        // copy on this device" warning is shared with the history surfaces.
        const openFile = () => getHost().navigation?.launchExternalFile(extKey);

        const showFile = () => {
            // Reveal the local copy in Finder/Explorer (right-click "Show File").
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

        // Both actions resolve the local copy on demand: "Open File" launches it
        // in the default app (the same as a left-click), "Show File" reveals it
        // in Finder/Explorer. Each no-ops gracefully when the copy is
        // unavailable on this device.
        const fileMenuItems: MenuItem[] = [
            { label: 'Open File', icon: ExternalLinkIcon, onClick: openFile },
            { label: 'Show File', icon: FileViewIcon, onClick: showFile },
        ];

        const { isRemoveMenuOpen, contextMenuHandlers, removeHandlers, removeMenu } = useRemoveContextMenu({
            onRemove: () => {
                if (onRemove) onRemove(extKey);
            },
            onRemoveAll,
            canEdit,
            disabled,
            extraMenuItems: fileMenuItems,
        });

        const normalIcon = (
            <span className="scale-80">
                <CSSItemTypeIcon itemType={EXTERNAL_FILE_ICON_BY_KIND[contentKind] || 'attachmentFile'} />
            </span>
        );

        const popup: ChipPopupContent = {
            icon: (
                <CSSItemTypeIcon
                    itemType={EXTERNAL_FILE_ICON_BY_KIND[contentKind] || 'attachmentFile'}
                    className="scale-90"
                />
            ),
            title: filename,
            subtitle: { text: 'External file' },
            action: { icon: ExternalLinkIcon, label: 'Open external file', iconClassName: 'scale-75' },
        };

        return (
            <>
            <ChipWithPopup popup={popup} suppressed={isRemoveMenuOpen}>
                <ChipButton
                    ref={ref}
                    className={`${className || ''} ${disabled ? 'disabled-but-styled' : ''}`}
                    disabled={disabled}
                    onClick={() => openFile()}
                    {...contextMenuHandlers}
                    {...rest}
                >
                    {canEdit && !disabled ? (
                        <ChipRemovableIcon
                            normalIcon={normalIcon}
                            removeHandlers={removeHandlers}
                            removeMenuOpen={isRemoveMenuOpen}
                        />
                    ) : normalIcon}
                    <span className="truncate">
                        {truncateText(filename, MAX_FILENAME_LENGTH)}
                    </span>
                    <Icon icon={ExternalLinkIcon} className="scale-95" />
                </ChipButton>
            </ChipWithPopup>
            {removeMenu}
            </>
        );
    }
);

export default ExternalFileButton;
