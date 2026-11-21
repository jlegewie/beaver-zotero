import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
    getToolResultRenderableCount,
    isToolResultView,
    type OpenAlexNamesView,
} from '@beaver/agent-core/run-state/toolResultViews';
import type { ToolReturnPart } from '@beaver/agent-core/agents/types';
import { OpenAlexNamesResultView } from '../../../react/components/agentRuns/toolResultViews/OpenAlexNamesResultView';
import { hasRenderableResult } from '../../../react/components/agentRuns/ToolResultView';

const render = (view: OpenAlexNamesView) => renderToStaticMarkup(React.createElement(OpenAlexNamesResultView, { view }));

const authors: OpenAlexNamesView = {
    view_type: 'openalex_names',
    kind: 'author',
    results: [{
        query: 'Katrin Wisniewski',
        candidates: [{
            id: 'A5012345678',
            name: 'Katrin Wisniewski',
            institutions: ['University of Leipzig', 'Max Planck Institute'],
            active_years: '2014–2024',
            works_count: 1234,
            cited_by_count: 5678,
            h_index: 21,
            topics: ['Second language acquisition'],
        }],
    }],
};

describe('OpenAlexNamesResultView', () => {
    it('shows an author with institutions, active years and counts, without a name heading for one name', () => {
        const html = render(authors);
        expect(html).toContain('Katrin Wisniewski');
        expect(html).toContain('University of Leipzig · Max Planck Institute');
        expect(html).toContain('2014–2024 · 1,234 works · 5,678 citations');
        // The name is a keyboard-reachable link to the OpenAlex page.
        expect(html).toContain('role="link" tabindex="0"');
        // One lookup: the label names it, so no heading repeats it.
        expect(html.split('Katrin Wisniewski').length - 1).toBe(1);
    });

    it('shows a venue with its abbreviation, publisher, type, ISSN and works count', () => {
        const html = render({
            view_type: 'openalex_names',
            kind: 'venue',
            results: [{
                query: 'NEJM',
                candidates: [{
                    id: 'S62468778', name: 'New England Journal of Medicine', abbreviation: 'N Engl J Med',
                    type: 'journal', publisher: 'Massachusetts Medical Society', issn_l: '0028-4793', works_count: 1,
                }],
            }],
        });
        expect(html).toContain('New England Journal of Medicine');
        expect(html).toContain(' (N Engl J Med)');
        expect(html).toContain('Massachusetts Medical Society · Journal');
        expect(html).toContain('ISSN 0028-4793 · 1 work');
    });

    it('puts each name above its candidates and reports names without any', () => {
        const html = render({
            view_type: 'openalex_names',
            kind: 'author',
            results: [
                authors.results[0],
                { query: 'Nobody Known', candidates: [] },
                { query: 'Jane Roe', candidates: [], error: 'OpenAlex could not be reached for this name; try again later.' },
            ],
        });
        expect(html.split('Katrin Wisniewski').length - 1).toBe(2);
        expect(html).toContain('Nobody Known</span><span> — not found');
        expect(html).toContain('Jane Roe</span><span> — lookup unavailable');
    });
});

describe('openalex_names view model', () => {
    it('is a renderable tool-result view that counts its names', () => {
        expect(isToolResultView(authors)).toBe(true);
        expect(isToolResultView({ view_type: 'openalex_names', kind: 'author' })).toBe(false);
        expect(getToolResultRenderableCount(authors)).toBe(1);
        const part: ToolReturnPart = {
            part_kind: 'tool-return', tool_name: 'openalex_resolve_names', tool_call_id: 'c1', content: {},
            metadata: { view: authors },
        };
        expect(hasRenderableResult(part)).toBe(true);
    });
});
