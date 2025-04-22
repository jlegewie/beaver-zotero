import { useEventSubscription } from './useEventSubscription';
import { getFileStatusForAttachmentInfo } from '../../src/ui/getFileStatusForAttachmentInfo';

export function useAttachmentStatusInfoRow() {
    
    useEventSubscription('getAttachmentStatus', async (detail) => {
        console.log(`getAttachmentStatus EVENT`);
        const { library_id, zotero_key } = detail;
        const attachmentItem = await Zotero.Items.getByLibraryAndKeyAsync(library_id, zotero_key);

        // 0. Check if item exists
        if (!attachmentItem) {
            return;
        }

        // 1. Check if item from event matches the selected item
        const selectedItems: Zotero.Item[] = Zotero.getActiveZoteroPane().getSelectedItems() || [];
        if(selectedItems.length === 0 || selectedItems.length > 1 || selectedItems[0].id !== attachmentItem.id) {
            return;
        }

        // 2. Get attachment status
        const statusInfo = await getFileStatusForAttachmentInfo(attachmentItem);
        console.log(`statusInfo: ${statusInfo}`);

        // 3. Update UI
        const beaverRow = Zotero.getMainWindow().document.getElementById('beaverStatusRow') as HTMLDivElement | null;
        if (!beaverRow) return;
        const statusLabel = beaverRow.querySelector('#beaver-status') as HTMLLabelElement | null;
        const statusButton = beaverRow.querySelector('#beaver-status-button') as HTMLButtonElement | null;
        if (statusLabel) {
            console.log(`Updating status label`);
            statusLabel.textContent = statusInfo.text;
        }
        if (statusButton) {
            statusButton.hidden = !statusInfo.showButton;
        }
    });
} 