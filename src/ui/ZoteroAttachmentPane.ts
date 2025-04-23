// import { logger } from '../../src/utils/logger';
// import { getFileStatusForAttachmentInfo } from './getFileStatusForAttachmentInfo';
import { eventManager } from '../../react/events/eventManager';

declare global {
    interface Element {
        hidden: boolean;
        tooltipText: string;
        label: string;
        oncommand: any;
    }
}

export type Trampoline = ((...args: unknown[]) => unknown) & { disabled?: boolean };
const trampolines: Trampoline[] = [];

export function patch<F extends (...args: any[]) => any>(
    object: Record<string, any>,
    method: string,
    patcher: (orig: F) => F,
    mem?: Array<(...args: any[]) => any>
): void {
    // 1) Check it really is a function
    if (typeof object[method] !== "function") {
        throw new Error(`monkey-patch: ${method} is not a function`);
    }

    // 2) Grab the original with a safe cast to F
    const orig = object[method] as F;

    // 3) Ask the patcher to give us a new function of the same signature
    const patched = patcher(orig);

    // 4) Swap in a trampoline wrapper that delegates based on disabled flag
    object[method] = function trampoline(
        this: unknown,
        ...args: Parameters<F>
    ): ReturnType<F> {
        // Force‐cast `trampoline` to our Trampoline type 
        const t = trampoline as unknown as Trampoline & F;
        return t.disabled
            ? orig.apply(this, args)
            : patched.apply(this, args);
    } as F & Trampoline;

    // 5) Keep track of this trampoline
    trampolines.push(object[method]);
    if (mem) mem.push(object[method]);
}

export function unpatch(functions?: Trampoline[]) {
    for (const trampoline of (functions || trampolines)) {
        trampoline.disabled = true
    }
}

export class ZoteroAttachmentPane {
    private observer: MutationObserver | null = null;
    private patched = false;
    private Zotero;
    private window: Window;
    private document: Document;

    constructor(win: Window) {
        this.window = win;
        this.document = win.document;
        this.Zotero = (win as any).Zotero; // Get Zotero instance from the window
    }

    // Wait for the attachment box to be ready and then initialize
    public async init(): Promise<void> {
        ztoolkit.log('ZoteroAttachmentPane: Initializing...');
        try {
            const attachmentBox = await this.waitForElement('#zotero-attachment-box');
            if (attachmentBox) {
                ztoolkit.log('ZoteroAttachmentPane: Found attachment-box, applying patch.');
                this.patchAttachmentBox(attachmentBox.constructor.prototype); // Patch the prototype
            } else {
                 ztoolkit.log('ZoteroAttachmentPane: Could not find attachment-box.');
            }
        } catch (err: any) {
            ztoolkit.log(`ZoteroAttachmentPane: Error initializing: ${err}`);
            Zotero.logError(err);
        }
    }

     // Helper to wait for an element to appear in the DOM
    private waitForElement(selector: string, timeout = 10000): Promise<Element | null> {
        return new Promise((resolve) => {
            const element = this.document.querySelector(selector);
            if (element) {
                return resolve(element);
            }

            const observer = new this.window.MutationObserver(() => {
                const element = this.document.querySelector(selector);
                if (element) {
                    observer.disconnect();
                    resolve(element);
                }
            });

            observer.observe(this.document.documentElement, {
                childList: true,
                subtree: true,
            });

            // Timeout
             setTimeout(() => {
                 observer.disconnect();
                 ztoolkit.log(`waitForElement timed out for selector: ${selector}`);
                 resolve(null); // Resolve with null on timeout
             }, timeout);
        });
    }

    private patchAttachmentBox(proto: any): void {
        if (this.patched) {
             ztoolkit.log('ZoteroAttachmentPane: Already patched.');
             return;
        }

        ztoolkit.log('ZoteroAttachmentPane: Patching AttachmentBox.prototype.asyncRender');

        // Store pending status check promise to avoid race conditions
        let pendingStatusCheck: Promise<void> | null = null;

        // --- The Core Patch ---
        patch(proto, 'asyncRender', original => async function(this: any, ...args: any[]) {
            // `this` refers to the attachment-box instance

            // 1. Run the original rendering logic first
            await original.apply(this, args);

            // 2. Safety check: Ensure we have an item and it's an attachment
            if (!this.item || !this.item.isAttachment()) {
                // Hide our row if no valid attachment is selected
                const customRow = this.querySelector('#beaverStatusRow');
                if (customRow) customRow.hidden = true;
                pendingStatusCheck = null; // Cancel any pending check
                return;
            }

            const attachmentItem = this.item as Zotero.Item;
            const currentItemId = attachmentItem.id;
            ztoolkit.log(`ZoteroAttachmentPane: Patched asyncRender starting for item ${currentItemId}`);

            const updateStatus = async () => {
                let beaverRow: Element | null = null;
                let statusLabel: HTMLLabelElement | null = null;

                try {
                    // 3. Ensure our custom row exists (might have been created by original render or previous run)
                    beaverRow = this.querySelector('#beaverStatusRow') as HTMLDivElement;
                    if (!beaverRow) {
                        ztoolkit.log('ZoteroAttachmentPane: Creating beaverStatusRow');
                        beaverRow = ZoteroAttachmentPane.createBeaverRow(this.ownerDocument); // Use static method
                        const metadataTable = this.querySelector('.metadata-table');
                        if (metadataTable) {
                            const indexRow = metadataTable.querySelector('#indexStatusRow');
                            if (indexRow && indexRow.nextSibling) {
                                metadataTable.insertBefore(beaverRow, indexRow.nextSibling);
                            } else {
                                metadataTable.appendChild(beaverRow);
                            }
                        } else {
                            ztoolkit.log('ZoteroAttachmentPane: Could not find .metadata-table to add row.');
                            return; // Can't add the row
                        }
                    }

                    // Find elements within the row
                    statusLabel = beaverRow.querySelector('#beaver-status') as HTMLLabelElement | null;

                    // 4. Show Loading State
                    if (statusLabel) statusLabel.textContent = 'Loading status...'; // Or use a spinner class/element
                    beaverRow.hidden = false; // Ensure row is visible

                    // 5. Get the status asynchronously for the current attachment
                    ztoolkit.log(`ZoteroAttachmentPane: Awaiting Beaver status for item ${currentItemId}`);
                    eventManager.dispatch('getAttachmentStatus', { 
                        library_id: attachmentItem.libraryID,
                        zotero_key: attachmentItem.key
                    });

                    // 6. Check if the selected item *still* matches the one we started fetching for
                    // This prevents updating the wrong row if the user selected another item quickly.
                    if (!this.item || this.item.id !== currentItemId) {
                        ztoolkit.log(`ZoteroAttachmentPane: Item changed (${this.item?.id}) while fetching status for ${currentItemId}. Aborting UI update.`);
                        return; // Bail out, a new asyncRender cycle will handle the current item
                    }

                } catch (err: any) {
                     ztoolkit.log(`ZoteroAttachmentPane: Error during async status update for ${currentItemId}: ${err}`);
                     Zotero.logError(err);
                     // Show error state in the UI
                     if (beaverRow) {
                         if (statusLabel) statusLabel.textContent = 'Error loading status';
                         beaverRow.hidden = false; // Make sure row is visible to show the error
                     }
                     if (beaverRow) beaverRow.hidden = true;
                }
            };

            // Execute the async update function
            pendingStatusCheck = updateStatus();
        });

        this.patched = true;
        ztoolkit.log('ZoteroAttachmentPane: Patching complete.');
    }

    // Static method to create the row structure
    private static createBeaverRow(doc: Document): Element {
        const elements = { // Simple helper for namespaced elements
            create: (tag: string, attrs: Record<string, any> = {}, children: Node[] = []) => {
                const ns = tag.startsWith('html:') ? 'http://www.w3.org/1999/xhtml' : null; // Basic namespace handling
                const el = ns ? doc.createElementNS(ns, tag.substring(5)) : doc.createElement(tag);
                for (const [key, value] of Object.entries(attrs)) {
                    el.setAttribute(key, String(value));
                }
                children.forEach(child => el.appendChild(child));
                return el;
            }
        };

        return elements.create('html:div', { id: 'beaverStatusRow', class: 'meta-row', hidden: 'true' }, [ // Start hidden
            elements.create('html:div', { class: 'meta-label' }, [
                elements.create('html:label', { id: 'beaver-status-label', class: 'key' }, [
                    doc.createTextNode('Beaver Status')
                ])
            ]),
            elements.create('html:div', { class: 'meta-data' }, [
                elements.create('html:label', { id: 'beaver-status' })
                /*elements.create('toolbarbutton', { // Use XUL toolbarbutton
                    id: 'beaver-status-button',
                    hidden: 'true', // Start hidden
                    tooltiptext: 'Reprocess File',
                    // 'oncommand' is set dynamically in the patch
                }
                )*/
            ])
        ]);
    }

    public unload(): void {
        ztoolkit.log('ZoteroAttachmentPane: Unloading...');
        const beaverRow = this.document.querySelector('#beaverStatusRow');
        beaverRow?.remove();
        this.patched = false; // Reset patch status
        ztoolkit.log('ZoteroAttachmentPane: Unloaded.');
    }
}

// Helper function to be called when a Zotero window loads
export async function newZoteroAttachmentPane(win: Window): Promise<ZoteroAttachmentPane | null> {
    try {
        const pane = new ZoteroAttachmentPane(win);
        await pane.init(); // Initialize and apply patch
        return pane;
    } catch (err: any) {
        ztoolkit.log(`ZoteroAttachmentPane: Error initializing: ${err}`);
        Zotero.logError(err);
        return null;
    }
}