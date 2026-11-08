/**
 * A tag or collection change refused as stale wrote nothing: its preview shows
 * the proposal, not a failure, since the card header says what changed.
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const { statusOf } = vi.hoisted(() => ({
    statusOf: (name: string) => ({ status }: { status?: string }) => `${name}:${status}`,
}));

vi.mock('../../../react/host/zotero/components/ManageTagsPreview', () => ({ ManageTagsPreview: statusOf('tags') }));
vi.mock('../../../react/host/zotero/components/ManageCollectionsPreview', () => ({ ManageCollectionsPreview: statusOf('collections') }));

import { ActionPreview } from '../../../react/host/zotero/components/ActionPreview';

const refused = {
    id: 'a1',
    status: 'error',
    result_data: null,
    error_details: { error_code: 'stale_proposal' },
} as any;

function render(actionType: string, actions: any[]) {
    return renderToStaticMarkup(React.createElement(ActionPreview, {
        toolName: actionType,
        previewData: { actionType, actionData: {}, errorMessage: 'The tag changed after this was proposed.' } as any,
        status: 'error',
        actions,
    }));
}

describe('ActionPreview for a stale proposal', () => {
    it.each(['manage_tags', 'manage_collections'])('shows %s as a proposal, not a failure', (actionType) => {
        expect(render(actionType, [refused])).toContain(':pending');
    });

    it('keeps a real failure as an error', () => {
        expect(render('manage_tags', [{ ...refused, error_details: { error_code: 'other' } }])).toContain('tags:error');
    });
});
