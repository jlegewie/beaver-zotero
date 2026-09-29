import type { MenuItem } from '@beaver/agent-ui/primitives/ContextMenu';
import type { ZoteroItemReference } from '@beaver/agent-core/types/zotero';
import { logger } from '@beaver/agent-core/platform/logger';
import { ExternalLinkIcon, FileViewIcon, FolderDetailIcon, LibraryIcon, NoteIcon } from '../../components/icons/icons';
import { openNote, openNoteWindow, showAttachmentInFilesystem, viewAttachment } from '../../runtime/navigation';
import { revealSource } from '../../utils/sourceUtils';
import { navigateToAnnotation } from '../../utils/readerUtils';
import { selectItemById } from '../../utils/selectItem';
import { resolveLibraryRef } from '../../../src/utils/libraryIdentity';

const READER_TYPE_LABELS: Record<string, string> = { pdf: 'PDF', epub: 'EPUB', snapshot: 'Snapshot' };

/** "Open <type> in New Tab" / "… in New Window", the preferred one first. */
function openEntries(typeLabel: string, prefersWindow: boolean, openIn: (window: boolean) => void): MenuItem[] {
    const inTab: MenuItem = { label: `Open ${typeLabel} in New Tab`, icon: FileViewIcon, onClick: () => openIn(false) };
    const inWindow: MenuItem = { label: `Open ${typeLabel} in New Window`, icon: ExternalLinkIcon, onClick: () => openIn(true) };
    return prefersWindow ? [inWindow, inTab] : [inTab, inWindow];
}

function showFileEntry(file: Zotero.Item): MenuItem {
    return {
        label: Zotero.isMac ? 'Show in Finder' : 'Show File',
        icon: FolderDetailIcon,
        onClick: () => void showAttachmentInFilesystem(file.id),
    };
}

/**
 * Select an annotation in the items tree. Releases whose items tree has no
 * annotation rows cannot select it, so its attachment is revealed instead.
 */
async function revealAnnotation(annotation: Zotero.Item, attachment: Zotero.Item): Promise<void> {
    const selected = await selectItemById(annotation.id).catch((error) => {
        logger(`itemMenuItems: selecting annotation ${annotation.key} failed: ${error}`, 2);
        return false;
    });
    if (!selected) revealSource({ library_id: attachment.libraryID, zotero_key: attachment.key });
}

/**
 * Annotation entries: "Show in <PDF|EPUB|Snapshot>" opens the reader at the
 * annotation, "Show in Library" selects it in the items tree (its attachment
 * where the tree has no annotation rows), and the attachment's file can be
 * shown.
 */
async function annotationEntries(annotation: Zotero.Item): Promise<MenuItem[]> {
    // The parent may not be in memory yet; the synchronous `parentItem` would miss it.
    const attachment = annotation.parentID ? await Zotero.Items.getAsync(annotation.parentID) : null;
    if (!attachment) return [];
    const typeLabel = READER_TYPE_LABELS[attachment.attachmentReaderType] ?? 'Attachment';
    const entries: MenuItem[] = [
        {
            label: `Show in ${typeLabel}`,
            icon: FileViewIcon,
            onClick: () => void navigateToAnnotation(annotation)
                .catch((error) => logger(`itemMenuItems: navigateToAnnotation: ${error}`, 2)),
        },
        {
            label: 'Show in Library',
            icon: LibraryIcon,
            onClick: () => void revealAnnotation(annotation, attachment),
        },
    ];
    if (attachment.isFileAttachment()) entries.push(showFileEntry(attachment));
    return entries;
}

/**
 * Right-click entries for a library item, mirroring Zotero's item context menu
 * with its English labels: "Show in Library"; "Open <PDF|EPUB|Snapshot|Note> in
 * New Tab / New Window" (a single "Open <type>" when an external viewer is set
 * for the type); and "Show in Finder" / "Show File". Regular items act on their
 * best attachment, like Zotero. Annotations get {@link annotationEntries}.
 *
 * Local reveal/open actions over persisted history, so deliberately not gated
 * on library exclusion.
 */
export async function itemMenuItems(ref: ZoteroItemReference): Promise<MenuItem[]> {
    const libraryID = resolveLibraryRef(ref);
    if (!libraryID) return [];
    const item = await Zotero.Items.getByLibraryAndKeyAsync(libraryID, ref.zotero_key);
    if (!item) return [];
    if (item.isAnnotation()) return annotationEntries(item);

    const entries: MenuItem[] = [{
        label: 'Show in Library',
        icon: LibraryIcon,
        onClick: () => revealSource({ ...ref, library_id: libraryID }),
    }];

    if (item.isNote()) {
        if (typeof (Zotero as any).Notes?.open === 'function') {
            entries.push(...openEntries('Note', Boolean(Zotero.Prefs.get('openNoteInNewWindow')), (inWindow) => {
                if (inWindow) void openNoteWindow(item.id);
                else void openNote(item.id).catch((error) => logger(`itemMenuItems: openNote: ${error}`, 2));
            }));
        } else {
            entries.push({ label: 'Open Note', icon: NoteIcon, onClick: () => void openNoteWindow(item.id) });
        }
        return entries;
    }

    // Regular items act on their attachments in Zotero's best-first order, which
    // excludes linked URLs: "Open" takes the first the reader supports, "Show
    // File" the first overall. A lookup failure still leaves "Show in Library".
    let candidates: Zotero.Item[] = [];
    try {
        if (item.isAttachment()) {
            candidates = [item];
        } else if (item.isRegularItem()) {
            // getBestAttachments() reads the attachment count and the url field,
            // which the async lookup above does not load.
            await Zotero.Items.loadDataTypes([item], ['itemData', 'childItems']);
            candidates = await item.getBestAttachments();
        }
    } catch (error) {
        logger(`itemMenuItems: attachment lookup failed for ${ref.zotero_key}: ${error}`, 2);
    }
    const attachment = candidates.find((candidate) => candidate.attachmentReaderType
        && candidate.attachmentLinkMode !== Zotero.Attachments.LINK_MODE_LINKED_URL);
    if (attachment) {
        const readerType = attachment.attachmentReaderType;
        const typeLabel = READER_TYPE_LABELS[readerType] ?? 'Attachment';
        if (Zotero.Prefs.get(`fileHandler.${readerType}`)) {
            entries.push({ label: `Open ${typeLabel}`, icon: FileViewIcon, onClick: () => void viewAttachment(attachment.id) });
        } else {
            // Zotero's "open in new window" preference decides where a plain open goes;
            // the other entry inverts it, like a shift-click.
            const prefersWindow = Boolean(Zotero.Prefs.get('openReaderInNewWindow'));
            entries.push(...openEntries(typeLabel, prefersWindow, (inWindow) => void viewAttachment(
                attachment.id, undefined, { forceAlternateWindowBehavior: inWindow !== prefersWindow },
            )));
        }
    }

    const file = item.isRegularItem() ? candidates[0] : item.isFileAttachment() ? item : null;
    if (file) entries.push(showFileEntry(file));
    return entries;
}
