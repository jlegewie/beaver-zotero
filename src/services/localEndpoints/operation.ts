import type { OperationContext } from '../agentDataProvider/operationContext';
import { loadPreferences } from '../deferredToolPolicy';

/** Originless operations never inherit a chat's grants, citations, or run identity. */
export function captureInstanceOperation(): OperationContext {
    const account = Zotero.Beaver.account;
    const target = Zotero.Beaver.runtime.resolveWindow();
    return {
        accountGeneration: account?.getGeneration(),
        userId: account?.getSnapshot().session?.user.id,
        preference: tool => {
            const prefs = loadPreferences();
            return prefs.groupPreferences[prefs.toolToGroup[tool] ?? tool] ?? 'always_ask';
        },
        renderMarkdown: async content => {
            if (!target) throw Object.assign(new Error('Note rendering is unavailable'), { code: 'capability_unavailable' });
            return Zotero.Beaver.runtime.dispatchWindowCommand('render-markdown', { content, windowId: target.id });
        },
    };
}
