/**
 * A table hands the `Citation` component the citation it assembled from a row
 * and one piece of evidence, rather than a tag looked up in the thread's
 * store. A tag names only a work and a locator, so two quotes of one work
 * share it; passed directly, each citation keeps its own quote.
 */
import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Provider, createStore } from 'jotai';
import type { Row } from '@beaver/agent-core/layouts/table';
import { citationForEvidence } from '@beaver/agent-core/layouts/tableCitations';
import Citation from '@beaver/agent-ui/chat/Citation';
import { useCitationViewModel } from '@beaver/agent-ui/chat/useCitationViewModel';

const row: Row = {
    id: 'r1',
    ref: { kind: 'item', library_ref: 'u', library_id: 1, zotero_key: 'ITEM0001' },
    cells: {
        _reference: {
            outcome: 'answered',
            provenance: 'system',
            value: { kind: 'reference', display_name: 'Smith 2023' },
        },
    },
};

function Probe({ citation }: { citation: unknown }): React.ReactElement {
    const vm = useCitationViewModel({ citation });
    return React.createElement('span', null, `${vm.displayState}|${vm.previewText}`);
}

function render(element: React.ReactElement): string {
    return renderToStaticMarkup(React.createElement(Provider, { store: createStore() }, element));
}

describe('direct citations', () => {
    const title = citationForEvidence(row, { quote: 'Sleep and memory', field: 'title' })!;
    const abstract = citationForEvidence(row, { quote: 'A sample of 120 adults', field: 'abstract' })!;

    it('share a tag but keep their own quotes', () => {
        expect(title.raw_tag).toBe(abstract.raw_tag);
        expect(render(React.createElement(Probe, { citation: title }))).toContain('ready|&quot;Sleep and memory&quot;');
        expect(render(React.createElement(Probe, { citation: abstract }))).toContain('ready|&quot;A sample of 120 adults&quot;');
    });

    it('render without anything in the citation store', () => {
        expect(render(React.createElement(Citation, { citation: title, marker: '2' }))).toContain('Smith 2023');
    });
});
