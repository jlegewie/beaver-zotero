/**
 * Find-in-chat highlighting of rendered markdown.
 *
 * Two properties matter here: with no active query the rendered markup must be
 * exactly what it was before find-in-chat existed, and with one the matches must
 * come out as the shared hit markup. `renderToStaticMarkup` is enough for both —
 * jsdom is not loaded for these tests.
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-ui/chat/Citation', () => ({
    default: () => null,
}));

vi.mock('../../../react/components/messages/NoteDisplay', () => ({
    default: () => null,
}));

import { FIND_HIT_ATTR, FIND_HIT_CLASS, FindQueryProvider } from '@beaver/agent-ui/chat/findContext';
import MarkdownRenderer from '../../../react/components/messages/MarkdownRenderer';

const CONTENT = 'The **quick** brown fox\n\njumps over the quick dog';

/** Render `CONTENT`, optionally under a find query. */
function render(options: { query?: string; exportRendering?: boolean } = {}): string {
    const markdown = React.createElement(MarkdownRenderer, {
        content: CONTENT,
        exportRendering: options.exportRendering,
    });
    const tree =
        options.query === undefined
            ? markdown
            : React.createElement(FindQueryProvider, { query: options.query }, markdown);
    return renderToStaticMarkup(tree);
}

const HIT_OPEN = `<mark class="${FIND_HIT_CLASS}" ${FIND_HIT_ATTR}="">`;

describe('MarkdownRenderer find highlighting', () => {
    it('renders no hit markup when no query is active', () => {
        expect(render()).not.toContain('<mark');
    });

    it('renders exactly the no-query markup for a query below the minimum length', () => {
        expect(render({ query: 'q' })).toBe(render());
    });

    it('wraps every match in the shared hit markup', () => {
        const html = render({ query: 'quick' });
        expect(html.split(HIT_OPEN).length - 1).toBe(2);
        expect(html).toContain(`${HIT_OPEN}quick</mark>`);
    });

    it('leaves the surrounding markdown structure intact', () => {
        // The hit sits inside the emphasis the markdown asked for, and removing
        // the hit markup gives back the unhighlighted rendering.
        const html = render({ query: 'quick' });
        expect(html).toContain(`<strong>${HIT_OPEN}quick</mark></strong>`);
        expect(html.replaceAll(HIT_OPEN, '').replaceAll('</mark>', '')).toBe(render());
    });

    it('matches case-insensitively while preserving the original casing', () => {
        expect(render({ query: 'THE QUICK' })).toContain(`${HIT_OPEN}the quick</mark>`);
    });

    it('never highlights an export render, whose output is saved into a note', () => {
        expect(render({ query: 'quick', exportRendering: true })).not.toContain('<mark');
    });
});
