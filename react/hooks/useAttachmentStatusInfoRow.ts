import { useEventSubscription } from './useEventSubscription';
import { getFileStatusForAttachmentInfo } from '../utils/getFileStatusForAttachmentInfo';
import { isAuthenticatedAtom } from '../atoms/auth';
import { store } from '../../react/index';
import { useEffect, useRef } from 'react';

export function useAttachmentStatusInfoRow() {
    // Keep a reference to the current button handler
    const buttonHandlerRef = useRef<(() => void) | null>(null);

    // Function to clean up event listeners
    const cleanupButtonHandler = () => {
        const statusButton = Zotero.getMainWindow().document.querySelector('#beaver-status-button') as HTMLButtonElement | null;
        if (statusButton && buttonHandlerRef.current) {
            statusButton.removeEventListener("command", buttonHandlerRef.current);
            buttonHandlerRef.current = null;
        }
    };

    // Clean up on unmount
    useEffect(() => {
        return () => {
            cleanupButtonHandler();
        };
    }, []);

    useEventSubscription('setAttachmentStatusInfoRow', async (detail) => {
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
        let statusInfo;
        if (store.get(isAuthenticatedAtom)) {
            statusInfo = await getFileStatusForAttachmentInfo(attachmentItem);
        } else {
            statusInfo = {
                text: 'Not authenticated',
                showButton: false,
                buttonDisabled: true
            };
        }

        // 4. Update UI
        const beaverRow = Zotero.getMainWindow().document.getElementById('beaverStatusRow') as HTMLDivElement | null;
        if (!beaverRow) return;
        
        const statusLabel = beaverRow.querySelector('#beaver-status') as HTMLLabelElement | null;
        if (statusLabel) {
            statusLabel.textContent = statusInfo.text;
        }
        
        // Clean up any existing event listener before proceeding
        cleanupButtonHandler();
        
        const statusButton = beaverRow.querySelector('#beaver-status-button') as HTMLButtonElement | null;
        if (!statusButton) {
            const statusButton = Zotero.getMainWindow().document.createXULElement("toolbarbutton");
            statusButton.setAttribute("id", "beaver-status-button");
            statusButton.setAttribute("tooltiptext", `Reprocess File`);
            statusLabel?.parentElement?.appendChild(statusButton);
        }
        
        if (statusButton) {
            statusButton.hidden = !statusInfo.showButton;
            statusButton.disabled = statusInfo.buttonDisabled || false;
            statusButton.setAttribute("tooltiptext", statusInfo.buttonTooltip || '');
            
            if (statusInfo.buttonIcon) {
                statusButton.style.listStyleImage = `url(${statusInfo.buttonIcon})`;
            }
            
            // Create new handler and store reference
            const newHandler = () => {
                statusButton!.disabled = true;
                setTimeout(() => {
                    statusButton!.disabled = false;
                    if (statusInfo.onClick) statusInfo.onClick();
                }, 1500);
            };
            
            // Store reference to the handler so we can remove it later
            buttonHandlerRef.current = newHandler;
            
            // Add new event listener
            statusButton.addEventListener("command", newHandler);
        }
    });
}