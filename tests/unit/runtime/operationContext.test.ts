/**
 * The context of a library operation a window starts with no run behind it:
 * no chat, run, grants or citation mappings. Runs build theirs per session in
 * the plugin realm (`registry.test.ts`).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { captureOperationContext } from '../../../react/runtime/operationContext';

beforeEach(() => {
    (Zotero as any).Beaver = {
        account: { getGeneration: () => 4, getSnapshot: () => ({ session: { user: { id: 'account-A' } } }) },
    };
});

describe('the operation context of a window command', () => {
    it('names the account, and no chat, run, grant or reference mapping', () => {
        const context = captureOperationContext();
        expect(context).toMatchObject({ accountGeneration: 4, userId: 'account-A', threadId: null, fullAccess: false, externalRefs: {}, externalItemMapping: {} });
        expect(context.runId).toBeUndefined();
        expect(context.owner).toBeUndefined();
        expect(context.onAttachmentResolved).toBeUndefined();
        // The user's preferences decide approvals (`getDeferredToolPreference`).
        expect(context.preference).toBeUndefined();
    });
});
