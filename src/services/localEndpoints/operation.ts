import type { OperationContext } from '../agentDataProvider/operationContext';
import { loadPreferences } from '../deferredToolPolicy';

/** Originless operations never inherit a chat's grants, citations, or run identity. */
export function captureInstanceOperation(): OperationContext {
    const account = Zotero.Beaver.account;
    return {
        accountGeneration: account?.getGeneration(),
        userId: account?.getSnapshot().session?.user.id,
        preference: tool => {
            const prefs = loadPreferences();
            return prefs.groupPreferences[prefs.toolToGroup[tool] ?? tool] ?? 'always_ask';
        },
        renderMarkdown: async (content, options) => Zotero.Beaver.exporter.renderNoteMarkdown(content, options),
    };
}
