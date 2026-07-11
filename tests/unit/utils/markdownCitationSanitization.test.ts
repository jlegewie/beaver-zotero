import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { captureCitationProps } = vi.hoisted(() => ({
    captureCitationProps: vi.fn(),
}));

vi.mock('../../../react/components/citations/Citation', () => ({
    default: (props: Record<string, unknown>) => {
        captureCitationProps(props);
        return null;
    },
}));

vi.mock('../../../react/components/messages/NoteDisplay', () => ({
    default: () => null,
}));

import MarkdownRenderer from '../../../react/components/messages/MarkdownRenderer';

describe('MarkdownRenderer citation sanitization', () => {
    const zotero = (globalThis as any).Zotero;
    const originalLibraries = zotero.Libraries;
    const originalGroups = zotero.Groups;

    beforeEach(() => {
        captureCitationProps.mockClear();
        zotero.Libraries = { ...originalLibraries, userLibraryID: 1 };
        zotero.Groups = {
            getLibraryIDFromGroupID: vi.fn(() => 7),
        };
    });

    afterEach(() => {
        zotero.Libraries = originalLibraries;
        zotero.Groups = originalGroups;
    });

    it('preserves a portable group library reference for the citation component', () => {
        renderToStaticMarkup(
            React.createElement(MarkdownRenderer, {
                content: '<citation id="g42-ABCD1234"/>',
            }),
        );

        expect(captureCitationProps).toHaveBeenCalledTimes(1);
        expect(captureCitationProps.mock.calls[0][0]).toMatchObject({
            'data-library-id': '7',
            'data-library-ref': 'g42',
            'data-zotero-key': 'ABCD1234',
        });
    });
});
