import { store } from "../../store";
import {
    dismissDiffPreview,
    isDiffPreviewActive,
    isDiffPreviewPending,
} from "../../utils/noteEditorDiffPreview";
import { diffPreviewNoteKeyAtom } from "../../utils/diffPreviewCoordinator";

/**
 * Dismiss the live note-edit preview, including a pending revision-guard
 * re-render, before an action is applied, rejected, or undone from any UI
 * surface.
 */
export async function dismissActiveEditNotePreview(): Promise<void> {
    if (!isDiffPreviewActive() && !isDiffPreviewPending()) return;
    await dismissDiffPreview();
    store.set(diffPreviewNoteKeyAtom, null);
}
