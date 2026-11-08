import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/utils/zoteroUtils', () => ({
    resolveFieldForItemType: (_typeID: number, field: string) => field,
}));

import { EditMetadataPreview } from '../../../react/host/zotero/components/EditMetadataPreview';

const edits = [
    { field: 'title', old_value: 'Old title', new_value: 'New title' },
    { field: 'pages', old_value: null, new_value: '1-10' },
] as any;

function render(props: Partial<React.ComponentProps<typeof EditMetadataPreview>>) {
    return renderToStaticMarkup(React.createElement(EditMetadataPreview, {
        edits,
        currentValues: { title: 'Old title', pages: null },
        status: 'applied',
        ...props,
    }));
}

describe('EditMetadataPreview after a partly failed apply', () => {
    it('names the fields that could not be set and why', () => {
        const html = render({
            appliedEdits: [{ field: 'title', applied_value: 'New title', old_value: 'Old title' }],
            failedEdits: [{ field: 'pages', error: "Error: 'pages' is not a valid field for type 'document'" }],
        });

        // Stored as String(error); shown without the "Error: " prefix.
        expect(html).toContain('Not changed: &#x27;pages&#x27; is not a valid field');
        expect(html).toContain('1 of 2 changes could not be made; the others were saved.');
    });

    it('says nothing about failures when every field was set', () => {
        const html = render({ appliedEdits: [], failedEdits: [] });

        expect(html).not.toContain('Not changed');
        expect(html).not.toContain('could not be made');
    });
});
