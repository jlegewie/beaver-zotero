/**
 * Cell and row citations of a research table, held to the shared
 * `table-citations.json` cases: the locator the grammar reads from the tag,
 * the target a click opens, and the chip and source rendered from the stored
 * preview alone.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Provider, createStore } from 'jotai';
import {
    normalizeCitationTag,
    parseLoc,
    parseRawCitationAttributes,
    parseTableLocator,
    requestedCitationKey,
} from '@beaver/agent-core/citations/citationGrammar';
import type { Citation as CitationMetadata } from '@beaver/agent-core/types/citations';
import Citation from '@beaver/agent-ui/chat/Citation';
import CitedSourcesList from '@beaver/agent-ui/chat/CitedSourcesList';
import { useCitationViewModel } from '@beaver/agent-ui/chat/useCitationViewModel';

const fixture = JSON.parse(
    readFileSync(fileURLToPath(new URL('../../fixtures/artifacts/table-citations.json', import.meta.url)), 'utf8'),
);
const cases: any[] = fixture.cases;

/** The citation the backend stores for a valid case. */
function stored(c: any): CitationMetadata {
    const tag = parseRawCitationAttributes(c.tag.match(/^<citation\b([^>]*)/)[1]);
    const requested = normalizeCitationTag(tag);
    if (!requested.ok) throw new Error('unparseable');
    return {
        citation_id: c.name,
        citation_type: 'table',
        requested_ref: requested.ref,
        resolved_ref: { kind: 'zotero', library_id: 1, library_ref: 'u', zotero_key: 'TABLEKEY', loc: c.citation.loc },
        display_name: c.citation.display_name,
        formatted_citation: fixture.table.spec.title,
        preview: c.citation.preview,
        raw_tag: c.tag,
        table: c.citation.table,
    };
}

function render(element: React.ReactElement): string {
    return renderToStaticMarkup(React.createElement(Provider, { store: createStore() }, element));
}

describe('the table-citations fixture corpus', () => {
    it('is populated', () => expect(cases.length).toBeGreaterThan(5));

    for (const c of cases)
        it(`reads the locator: ${c.name}`, () => {
            expect(parseLoc(c.locator.raw)).toEqual(c.locator);
            const attrs = parseRawCitationAttributes(c.tag.match(/^<citation\b([^>]*)/)[1]);
            const normalized = normalizeCitationTag(attrs);
            expect(normalized.ok && normalized.ref.loc).toEqual(c.locator);
        });

    for (const c of cases.filter((c) => c.citation?.loc))
        it(`targets the stored row and column: ${c.name}`, () => {
            const target = parseTableLocator(c.citation.loc);
            const [rowId, columnId] = c.citation.loc.value.split('/');
            expect(target).toEqual(columnId ? { rowId, columnId } : { rowId });
            expect(fixture.table.spec.rows.some((row: any) => row.id === rowId)).toBe(true);
        });
});

describe('a cell locator', () => {
    it('keeps each cited cell apart, and is not a record id', () => {
        const keys = cases
            .filter((c) => c.locator.kind === 'cell')
            .map((c) => requestedCitationKey({ kind: 'zotero', library_id: 1, library_ref: 'u', zotero_key: 'TABLEKEY', loc: c.locator }));
        expect(new Set(keys).size).toBe(new Set(cases.filter((c) => c.locator.kind === 'cell').map((c) => c.locator.raw)).size);
        expect(parseTableLocator(parseLoc('s12'))).toBeNull();
    });
});

describe('a table citation', () => {
    const cell = stored(cases.find((c) => c.name === 'the user\'s own answer'));
    const row = stored(cases.find((c) => c.name === 'a whole row'));

    function Probe({ citation }: { citation: CitationMetadata }): React.ReactElement {
        const vm = useCitationViewModel({ citation });
        return React.createElement('span', null, `${vm.displayState}|${vm.locatorDisplay}|${vm.pages.length}`);
    }

    it('shows no locator: the chip names the paper', () => {
        expect(render(React.createElement(Probe, { citation: cell }))).toContain('ready||0');
        expect(render(React.createElement(Probe, { citation: row }))).toContain('ready||0');
    });

    it('renders its chip from the stored preview, as the paper', () => {
        const html = render(React.createElement(Citation, { citation: cell }));
        expect(html).toContain('>Smith et al. 2021<');
        expect(html).toContain('with-locator');
    });

    it('exports as plain text, not as a citation of the table item', () => {
        const html = render(React.createElement(Citation, { citation: cell, exportRendering: true }));
        expect(html).toContain('(Smith et al. 2021)');
        expect(html).not.toContain('data-citation');
    });

    it('lists as its table in the cited sources', () => {
        const html = render(React.createElement(CitedSourcesList, { citations: [{ ...cell, numericCitation: '1' }] }));
        expect(html).toContain('Study designs');
        expect(html).toContain('Research table');
        expect(html).toContain('Open table');
        expect(html).not.toContain('Open PDF');
    });
});
