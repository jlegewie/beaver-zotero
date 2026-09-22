import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { AttachmentSearchView } from '@beaver/agent-core/run-state/toolResultViews';
import { AttachmentSearchResultView } from '../../../react/components/agentRuns/toolResultViews/AttachmentSearchResultView';

vi.mock('../../../react/components/icons/icons', () => ({
    CSSItemTypeIcon: () => null,
    Icon: () => null,
    ArrowDownIcon: () => null,
    ArrowRightIcon: () => null,
    ExternalLinkIcon: () => null,
}));

function preview(snippet: string, phrases?: unknown, toolName: AttachmentSearchView['tool_name'] = 'fulltext_search') {
    const view: AttachmentSearchView = {
        view_type: 'attachment_search', tool_name: toolName, query: 'social capital',
        total_matches: 1, attachment_count: 1,
        ...(phrases === undefined ? {} : { highlight_phrases: phrases as string[] | null }),
        attachments: [{
            library_id: 1, zotero_key: 'ABCDEFGH', display_name: 'Paper',
            content_kind: 'pdf', match_count: 1, pages: [], is_external: false, matches: [{ snippet }],
        }],
    };
    const html = renderToStaticMarkup(React.createElement(AttachmentSearchResultView, { view }));
    const marked = Array.from(html.matchAll(/<mark[^>]*>(.*?)<\/mark>/gs), (m) => m[1]);
    const text = html.match(/“(.*?)”/s)?.[1].replace(/<[^>]*>/g, '');
    return { marked, text };
}

describe('attachment search preview highlighting', () => {
    it.each([undefined, null])('keeps legacy terms separate for %s', (phrases) => {
        expect(preview('social capital and social ties', phrases, 'find_in_attachments').marked)
            .toEqual(['social', 'capital', 'social']);
    });

    it.each([[], 'social capital', 12, {}, [null, 12]])('ignores empty or malformed phrase lists: %j', (phrases) => {
        const snippet = 'Long introductory context before the social capital passage';
        expect(preview(snippet, phrases)).toEqual({ marked: [], text: snippet });
    });

    it('keeps valid entries in a mixed phrase list', () => {
        expect(preview('social capital', [null, 'social capital']).marked).toEqual(['social capital']);
    });

    it.each(['social and capital', 'social 19 capital', 'social. Capital', 'social, capital', 'social! Capital', 'social? Capital'])('does not match separated words: %s', (snippet) => {
        expect(preview(snippet, ['social capital'])).toEqual({ marked: [], text: snippet });
    });

    it.each(['social capital', 'Social-Capital', 'social\ncapital', 'social‐capital', 'social‑capital'])('matches spacing and hyphens: %s', (snippet) => {
        expect(preview(snippet, ['social capital']).marked).toEqual([snippet]);
    });

    it('merges overlapping phrases', () => {
        expect(preview('social capital formation', ['social capital', 'capital formation']).marked)
            .toEqual(['social capital formation']);
    });

    it.each([0, 20])('preserves the preview when the first hit starts at %i', (lead) => {
        const snippet = ' '.repeat(lead) + 'social capital';
        expect(preview(snippet, ['social capital']).text).toBe(snippet);
    });

    it('anchors on the first hit after the lead threshold', () => {
        const snippet = '.'.repeat(21) + 'social capital then social capital';
        expect(preview(snippet, ['social capital']).text)
            .toBe('… ' + '.'.repeat(20) + 'social capital then social capital');
    });

    it('anchors on a real phrase after an earlier sentence boundary', () => {
        const snippet = 'social. Capital ' + 'context '.repeat(8) + 'social capital';
        expect(preview(snippet, ['social capital']))
            .toEqual({ marked: ['social capital'], text: '… context context social capital' });
    });
});
