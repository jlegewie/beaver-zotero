import { useEventSubscription } from './useEventSubscription';
import { getFileStatusForAttachmentInfo } from '../../src/ui/getFileStatusForAttachmentInfo';

export function useAttachmentStatusInfoRow() {
    
    useEventSubscription('getAttachmentStatus', async (detail) => {
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
        if (statusLabel) {
            statusLabel.textContent = statusInfo.text;
        }
        const statusButton = beaverRow.querySelector('#beaver-status-button') as HTMLButtonElement | null;
        if (!statusButton) {
            const statusButton = Zotero.getMainWindow().document.createXULElement("toolbarbutton");
            statusButton.setAttribute("id", "beaver-status-button");
            statusButton.setAttribute("tooltiptext", `Reprocess File`);
            statusLabel?.parentElement?.appendChild(statusButton);
        }
        const statusButton_new = beaverRow.querySelector('#beaver-status-button') as HTMLButtonElement | null;
        if (statusButton_new) {
            statusButton_new.hidden = !statusInfo.showButton;
            statusButton_new.disabled = statusInfo.buttonDisabled || false;
            statusButton_new.setAttribute("tooltiptext", statusInfo.buttonTooltip || '');
            // Event handlers
            // @ts-ignore custom event handler
            statusButton_new.removeEventListener("command", statusButton_new._existingHandler);
            // @ts-ignore custom event handler
            statusButton_new._existingHandler = () => {
                statusButton_new.disabled = true;
                setTimeout(() => {
                    statusButton_new.disabled = false;
                    if (statusInfo.onClick) statusInfo.onClick();
                }, 50);
            };
            // @ts-ignore custom event handler
            statusButton_new.addEventListener("command", statusButton_new._existingHandler);
        }
    });
} 