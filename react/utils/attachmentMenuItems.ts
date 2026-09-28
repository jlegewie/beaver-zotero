import type { MenuItem } from '@beaver/agent-ui/primitives/ContextMenu';
import { ExternalLinkIcon, FileViewIcon, FolderDetailIcon, LibraryIcon } from '../components/icons/icons';
import { showAttachmentInFilesystem, viewAttachment } from '../runtime/navigation';
import { revealSource } from './sourceUtils';

const READER_TYPE_LABELS: Record<string, string> = { pdf: 'PDF', epub: 'EPUB', snapshot: 'Snapshot' };

/**
 * Context-menu entries for one attachment, mirroring the file entries of
 * Zotero's item context menu with its English labels: "Show in Library",
 * "Open <type> in New Tab" / "… in New Window" (the preferred one first, or a
 * single "Open <type>" when an external viewer is configured for the type), and
 * "Show in Finder" / "Show File".
 *
 * Local reveal/open actions: not gated on library exclusion. Returns an empty
 * list when the item no longer exists.
 */
export function attachmentMenuItems(libraryID: number, zoteroKey: string): MenuItem[] {
    const item = Zotero.Items.getByLibraryAndKey(libraryID, zoteroKey);
    if (!item) return [];

    const items: MenuItem[] = [{
        label: 'Show in Library',
        icon: LibraryIcon,
        onClick: () => revealSource({ library_id: libraryID, zotero_key: zoteroKey }),
    }];
    if (!item.isAttachment()) return items;

    const readerType: string | undefined = item.attachmentReaderType;
    if (readerType && item.attachmentLinkMode !== Zotero.Attachments.LINK_MODE_LINKED_URL) {
        const typeLabel = READER_TYPE_LABELS[readerType] ?? 'Attachment';
        if (Zotero.Prefs.get(`fileHandler.${readerType}`)) {
            items.push({ label: `Open ${typeLabel}`, icon: FileViewIcon, onClick: () => void viewAttachment(item.id) });
        } else {
            const prefersWindow = Boolean(Zotero.Prefs.get('openReaderInNewWindow'));
            const inTab: MenuItem = {
                label: `Open ${typeLabel} in New Tab`,
                icon: FileViewIcon,
                onClick: () => void viewAttachment(item.id, undefined, { forceAlternateWindowBehavior: prefersWindow }),
            };
            const inWindow: MenuItem = {
                label: `Open ${typeLabel} in New Window`,
                icon: ExternalLinkIcon,
                onClick: () => void viewAttachment(item.id, undefined, { forceAlternateWindowBehavior: !prefersWindow }),
            };
            items.push(...(prefersWindow ? [inWindow, inTab] : [inTab, inWindow]));
        }
    }

    if (item.isFileAttachment()) {
        items.push({
            label: Zotero.isMac ? 'Show in Finder' : 'Show File',
            icon: FolderDetailIcon,
            onClick: () => void showAttachmentInFilesystem(item.id),
        });
    }
    return items;
}
