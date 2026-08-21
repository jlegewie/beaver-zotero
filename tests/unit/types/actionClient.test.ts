/**
 * The action-client seam: which client `agent-core` reports this build as, and
 * how that value reaches the share format's compatibility check.
 *
 * The seam is module-level state, so each test restores the default afterwards.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { getActionClient, setActionClient } from '@beaver/agent-core/types/actions';
import { toShareableActionFile, parseShareableAction, SHAREABLE_ACTION_KIND } from '../../../react/types/actionShare';
import type { Action } from '@beaver/agent-core/types/actions';

const minimal: Action = { id: 'x', title: 'T', text: 'P', targets: ['global'] };

afterEach(() => {
    setActionClient('zotero-plugin');
});

describe('action client seam', () => {
    it('defaults to the Zotero plugin when no host has registered', () => {
        expect(getActionClient()).toBe('zotero-plugin');
    });

    it('reports the client a host registers', () => {
        setActionClient('word-addin');
        expect(getActionClient()).toBe('word-addin');
    });

    it('stamps the registered client on an exported action', () => {
        setActionClient('word-addin');
        expect(toShareableActionFile(minimal).action.client).toEqual(['word-addin']);
    });

    it('gates an imported action on the registered client', () => {
        const json = JSON.stringify({
            kind: SHAREABLE_ACTION_KIND,
            version: 1,
            action: { title: 'T', text: 'P', targets: ['global'], client: ['zotero-plugin'] },
        });
        expect(parseShareableAction(json).ok).toBe(true);
        setActionClient('word-addin');
        expect(parseShareableAction(json).ok).toBe(false);
    });
});
