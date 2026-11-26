import type { OperationContext } from '../../src/services/agentDataProvider/operationContext';

/**
 * The context of a library operation a window starts with no run behind it
 * (a development command): no chat, no run, no approval granted beyond the
 * user's preferences, no citation mappings. Runs build theirs in the plugin
 * realm, per session.
 */
export function captureOperationContext(): OperationContext {
    return {
        accountGeneration: Zotero.Beaver.account?.getGeneration(),
        userId: Zotero.Beaver.account?.getSnapshot().session?.user.id,
        threadId: null,
        fullAccess: false,
        externalRefs: {},
        externalItemMapping: {},
    };
}
