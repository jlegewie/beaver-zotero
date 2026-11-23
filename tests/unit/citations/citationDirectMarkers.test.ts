// @vitest-environment jsdom

/**
 * Table evidence numbers its own citations. Mounting one must not take a
 * number from the thread's marker map, which numbers the chat's sources.
 */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { Provider, createStore } from 'jotai';
import type { Row } from '@beaver/agent-core/layouts/table';
import { citationKeyToMarkerAtom } from '@beaver/agent-core/citations/atoms';
import { citationForEvidence } from '@beaver/agent-core/layouts/tableCitations';
import Citation from '@beaver/agent-ui/chat/Citation';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const row: Row = {
    id: 'r1',
    ref: { kind: 'item', library_ref: 'u', library_id: 1, zotero_key: 'ITEM0001' },
    cells: {},
};

describe('direct citation markers', () => {
    it('leave the thread marker map untouched', () => {
        const store = createStore();
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);
        const citation = citationForEvidence(row, { quote: 'q', locator: 's3' })!;
        act(() => {
            root.render(React.createElement(Provider, { store }, React.createElement(Citation, { citation, marker: '4' })));
        });
        expect(store.get(citationKeyToMarkerAtom)).toEqual({});
        act(() => root.unmount());
        container.remove();
    });
});
