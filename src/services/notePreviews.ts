import { restorePreviewEditor } from './restorePreviewEditor';
/** Instance registry for editor-specific preview ownership and awaited restoration. */
export class NotePreviews {
    private mutationActive = false;

    setMutationActive(active: boolean): void { this.mutationActive = active; }

    private restorations = new Map<object, Promise<void>>();

    restoreEditor(editor: object, wasSavingDisabled: boolean, itemId: number): Promise<void> {
        const pending = restorePreviewEditor(editor, wasSavingDisabled, itemId);
        this.restorations.set(editor, pending);
        void pending.finally(() => { if (this.restorations.get(editor) === pending) this.restorations.delete(editor); });
        return pending;
    }

    private dismissEntry(editor: object, entry: { dismiss: () => void }): Promise<void> {
        // The renderer performs synchronous presentation cleanup. Await the
        // plugin-owned restoration, never a promise from a closing renderer.
        entry.dismiss();
        const restoration = this.restorations.get(editor);
        return restoration ?? Promise.resolve();
    }

    private entries = new Map<object, { owner: string; libraryId: number; key: string; dismiss: () => void }>();

    claim(editor: object, entry: { owner: string; libraryId: number; key: string; dismiss: () => void }): (() => void) | null {
        if (this.mutationActive || this.entries.has(editor)) return null;
        this.entries.set(editor, entry);
        return () => { if (this.entries.get(editor) === entry) this.entries.delete(editor); };
    }

    async dismissNote(libraryId: number, key: string): Promise<void> {
        await Promise.all([...this.entries.entries()]
            .filter(([, entry]) => entry.libraryId === libraryId && entry.key === key)
            .map(([editor, entry]) => this.dismissEntry(editor, entry)));
    }

    async detachOwner(owner: string): Promise<void> {
        await Promise.all([...this.entries.entries()]
            .filter(([, entry]) => entry.owner === owner).map(async ([editor, entry]) => {
                try { await this.dismissEntry(editor, entry); }
                finally { if (this.entries.get(editor) === entry) this.entries.delete(editor); }
            }));
    }
}

export async function dismissNotePreviews(libraryId: number, key: string): Promise<void> {
    await Zotero.Beaver?.notePreviews?.dismissNote(libraryId, key);
}
