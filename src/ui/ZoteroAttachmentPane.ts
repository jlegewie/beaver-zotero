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

        // Keep track of the item ID for which the update process is active
        let activeItemId: number | null = null;

        patch(proto, 'asyncRender', original => async function(this: any, ...args: any[]) {
            const currentItem = this.item; // Get current item context
            const currentItemId = currentItem ? currentItem.id : null;

            // --- Reset Lock Condition ---
            // If the current item is different from the active one, clear the lock.
            // This allows processing for a new item selection.
            if (currentItemId !== activeItemId) {
                 ztoolkit.log(`ZoteroAttachmentPane: Item changed (${currentItemId ?? 'null'} vs ${activeItemId ?? 'null'}), clearing lock.`);
                activeItemId = null;
            }

            // 1. Run original rendering
            await original.apply(this, args);

            // 2. Safety check
            if (!currentItem || !currentItem.isAttachment()) {
                const customRow = this.querySelector('#beaverStatusRow');
                if (customRow) customRow.hidden = true;
                // Clear lock if no valid attachment is displayed
                activeItemId = null;
                return;
            }

            // --- Debounce Logic ---
            // If an update for this *specific* item is already active, skip.
            if (currentItemId === activeItemId) {
                return;
            }

            // --- Acquire Lock ---
            // Mark this item ID as active *before* starting the async work.
            activeItemId = currentItemId;
             ztoolkit.log(`ZoteroAttachmentPane: Acquired lock for item ${currentItemId}. Starting update process.`);


            const updateStatus = async () => {
                 // Capture the ID this specific updateStatus is for
                const itemIdForThisUpdate = currentItemId;
                 ztoolkit.log(`ZoteroAttachmentPane: updateStatus started for item ${itemIdForThisUpdate}`);

                let beaverRow: Element | null = this.querySelector('#beaverStatusRow');
                let statusLabel: HTMLLabelElement | null = null;

                try {
                    // 3. Ensure row exists (Create ONLY if not found)
                    if (!beaverRow) {
                         ztoolkit.log(`ZoteroAttachmentPane: Creating beaverStatusRow for item ${itemIdForThisUpdate}.`);
                        beaverRow = ZoteroAttachmentPane.createBeaverRow(this.ownerDocument); // Pass correct document context
                        const metadataTable = this.querySelector('.metadata-table');
                        if (metadataTable) {
                            const indexRow = metadataTable.querySelector('#indexStatusRow');
                            metadataTable.insertBefore(beaverRow, indexRow?.nextSibling ?? null);
                             ztoolkit.log(`ZoteroAttachmentPane: beaverStatusRow added to DOM for item ${itemIdForThisUpdate}.`);
                        } else {
                             ztoolkit.log(`ZoteroAttachmentPane: Could not find .metadata-table for item ${itemIdForThisUpdate}.`);
                            // If we fail to add the row, we should release the lock for this item
                            if (activeItemId === itemIdForThisUpdate) {
                                activeItemId = null;
                            }
                            return;
                        }
                    } else {
                         ztoolkit.log(`ZoteroAttachmentPane: Found existing beaverStatusRow for item ${itemIdForThisUpdate}.`);
                    }

                    statusLabel = beaverRow.querySelector('#beaver-status') as HTMLLabelElement | null;

                    // 4. Show Loading State
                    if (statusLabel) statusLabel.textContent = 'Loading status...';
                    beaverRow.hidden = false;

                    // 5. Dispatch event
                    // Check if the lock is *still* held by *this* item before dispatching.
                    // This prevents a potential race condition if the user clicks away *very* fast.
                    if (activeItemId !== itemIdForThisUpdate) {
                         ztoolkit.log(`ZoteroAttachmentPane: Lock changed (${activeItemId ?? 'null'}) before dispatching for ${itemIdForThisUpdate}. Aborting dispatch.`);
                        return; // Don't dispatch if the lock was cleared or taken by another item
                    }
                    // Also check if the item context in the pane `this.item` still matches.
                     if (!this.item || this.item.id !== itemIdForThisUpdate) {
                          ztoolkit.log(`ZoteroAttachmentPane: Item context changed (${this.item?.id}) before dispatching for ${itemIdForThisUpdate}. Aborting dispatch.`);
                         // Although the lock might still be ours, the UI context moved on. Release lock.
                         if (activeItemId === itemIdForThisUpdate) {
                             activeItemId = null;
                         }
                         return;
                     }


                    ztoolkit.log(`ZoteroAttachmentPane: Dispatching setAttachmentStatusInfoRow event for item ${itemIdForThisUpdate}`);
                    eventManager.dispatch('setAttachmentStatusInfoRow', {
                        library_id: currentItem.libraryID, // Use currentItem from outer scope
                        zotero_key: currentItem.key
                    });

                } catch (err: any) {
                     ztoolkit.log(`ZoteroAttachmentPane: Error during updateStatus for item ${itemIdForThisUpdate}: ${err}`);
                     Zotero.logError(err);
                     // Attempt to show error in UI
                     if (beaverRow) {
                         statusLabel = beaverRow.querySelector('#beaver-status') as HTMLLabelElement | null;
                         if (statusLabel) statusLabel.textContent = 'Error loading status';
                         beaverRow.hidden = false;
                     }
                }
            };

            // Execute the async update function
            updateStatus();
        });

        this.patched = true;
        ztoolkit.log('ZoteroAttachmentPane: Patching complete.');
    }

    // Static method to create the row structure (NO BUTTON HERE)
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
        // Create row structure *without* the button initially
        return elements.create('html:div', { id: 'beaverStatusRow', class: 'meta-row', hidden: 'true' }, [
            elements.create('html:div', { class: 'meta-label' }, [
                elements.create('html:label', { id: 'beaver-status-label', class: 'key' }, [
                    doc.createTextNode('Beaver Status')
                ])
            ]),
            elements.create('html:div', { id: 'beaver-status-data', class: 'meta-data flex items-center' }, [
                elements.create('html:label', { id: 'beaver-status', class: 'mr-1' })
                // Button will be added/managed by the React hook
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