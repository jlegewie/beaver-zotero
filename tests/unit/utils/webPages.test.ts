import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import {
    normalizeWebUrl,
    parseWebLinkHref,
    textFragmentUrl,
    tryNormalizeWebUrl,
} from '@beaver/agent-core/identity/webPages';
import { externalIdNamespace, supplierForExternalId, webPageId } from '@beaver/agent-core/citations/externalRecords';
import { normalizeCitationTag, parseLoc } from '@beaver/agent-core/citations/citationGrammar';

const FIXTURE = JSON.parse(
    readFileSync(join(__dirname, '../../fixtures/external_references/web_urls.json'), 'utf8'),
) as { cases: Array<{ input: string; normalized: string; web_id: string }>; invalid: string[] };

/** The backend's key: standard base32 of the SHA-256 of the normalized URL, first 10 characters. */
function webIdFor(normalized: string): string {
    const bytes = createHash('sha256').update(normalized, 'utf8').digest();
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = '';
    for (const byte of bytes) bits += byte.toString(2).padStart(8, '0');
    let key = '';
    for (let i = 0; i < 50; i += 5) key += alphabet[parseInt(bits.slice(i, i + 5), 2)];
    return `web-${key}`;
}

describe('normalizeWebUrl (shared fixture with the backend)', () => {
    it.each(FIXTURE.cases)('normalizes $input like the backend', ({ input, normalized, web_id }) => {
        expect(normalizeWebUrl(input)).toBe(normalized);
        expect(webIdFor(normalizeWebUrl(input))).toBe(web_id);
    });

    it.each(FIXTURE.invalid)('rejects %j', (input) => {
        expect(() => normalizeWebUrl(input)).toThrow();
        expect(tryNormalizeWebUrl(input)).toBeNull();
    });
});

describe('web page ids', () => {
    it('recognizes web- ids in any case and returns the canonical form', () => {
        expect(webPageId('web-mjnnmkh4ed')).toBe('web-MJNNMKH4ED');
        expect(externalIdNamespace('web-MJNNMKH4ED')).toBe('web');
        expect(supplierForExternalId('web-MJNNMKH4ED')).toBe('exa');
        expect(webPageId('web-MJNNMKH4E1')).toBeNull(); // 1 is not in the base32 alphabet
        expect(webPageId('web-MJNNMKH4E')).toBeNull();
    });

    it('parses web- link targets and nothing else', () => {
        expect(parseWebLinkHref('web-MJNNMKH4ED')).toBe('web-MJNNMKH4ED');
        expect(parseWebLinkHref('https://who.int')).toBeNull();
        expect(parseWebLinkHref('u-ABCD1234')).toBeNull();
    });

    it('parses web citations written with id= or external_id=', () => {
        const byId = normalizeCitationTag({ id: 'web-mjnnmkh4ed', loc: 's12-s14' });
        expect(byId.ok && byId.ref).toMatchObject({ kind: 'external', external_id: 'web-MJNNMKH4ED', loc: { kind: 'sentence', value: '12-14' } });
        const byExternalId = normalizeCitationTag({ external_id: 'web-MJNNMKH4ED', loc: 'h3' });
        expect(byExternalId.ok && byExternalId.ref).toMatchObject({ kind: 'external', external_id: 'web-MJNNMKH4ED', loc: { kind: 'highlight', value: '3' } });
    });

    it('parses highlight locators without taking heading ids', () => {
        expect(parseLoc('h3-h4')).toMatchObject({ kind: 'highlight', value: '3-4' });
        expect(parseLoc('heading12')).toMatchObject({ kind: 'heading', value: '12' });
    });
});

describe('textFragmentUrl', () => {
    const url = 'https://www.who.int/news-room/fact-sheets/detail/obesity';

    it('matches a short sentence whole, with reserved characters encoded', () => {
        expect(textFragmentUrl(url, [{ partId: 's1', text: 'In 2022, 1 in 8 had obesity-related disease & more.' }]))
            .toBe(`${url}#:~:text=In%202022%2C%201%20in%208%20had%20obesity%2Drelated%20disease%20%26%20more.`);
    });

    it('joins consecutive sentences into one start,end range and splits gaps into directives', () => {
        const long = 'One two three four five six seven eight nine ten eleven.';
        const result = textFragmentUrl(url, [
            { partId: 's12', text: long },
            { partId: 's13', text: 'Closing words of the passage here.' },
            { partId: 's20', text: 'Separate.' },
        ]);
        expect(result).toBe(`${url}#:~:text=One%20two%20three%20four%20five,words%20of%20the%20passage%20here.&text=Separate.`);
    });

    it('never joins two sentences into one term, since a heading or list item is its own block', () => {
        // A date line, a heading and a bullet: the start term stays inside the date line.
        expect(textFragmentUrl(url, [
            { partId: 's1', text: '7 October 2026' },
            { partId: 's2', text: 'Key facts' },
            { partId: 's3', text: 'Of these, 940 million were living with obesity.' },
        ])).toBe(`${url}#:~:text=7%20October%202026,million%20were%20living%20with%20obesity.`);
        // Two short list items are a range, not one exact match across both.
        expect(textFragmentUrl(url, [
            { partId: 's19', text: 'overweight is a BMI of 25; and' },
            { partId: 's20', text: 'obesity is a BMI of 30.' },
        ])).toBe(`${url}#:~:text=overweight%20is%20a%20BMI%20of,is%20a%20BMI%20of%2030.`);
    });

    it('keeps an existing fragment and leaves PDFs and empty text alone', () => {
        expect(textFragmentUrl('https://a.org/x#intro', [{ text: 'Hello world.' }])).toBe('https://a.org/x#intro:~:text=Hello%20world.');
        expect(textFragmentUrl('https://a.org/report.pdf', [{ text: 'Hello.' }])).toBe('https://a.org/report.pdf');
        // The backend's import classifier also treats a final /pdf as a PDF link.
        expect(textFragmentUrl('https://a.org/doi/10.1/x/pdf', [{ text: 'Hello.' }])).toBe('https://a.org/doi/10.1/x/pdf');
        expect(textFragmentUrl(url, [{ text: '  ' }])).toBe(url);
    });
});

describe('web page exports', () => {
    const pages: Record<string, string> = { 'web-MJNNMKH4ED': 'https://www.who.int/fact-sheets/obesity' };

    it('rewrites web- link targets to the page URL and leaves unknown ids and prose alone', async () => {
        const { rewriteWebLinkTargets } = await import('@beaver/agent-core/identity/webPages');
        const md = 'See [the fact sheet](web-MJNNMKH4ED), <a href="web-MJNNMKH4ED">it</a>, [x](web-X45SUKGLKI) and web-MJNNMKH4ED.';
        expect(rewriteWebLinkTargets(md, (id) => pages[id])).toBe(
            'See [the fact sheet](https://www.who.int/fact-sheets/obesity), <a href="https://www.who.int/fact-sheets/obesity">it</a>, [x](web-X45SUKGLKI) and web-MJNNMKH4ED.',
        );
        expect(rewriteWebLinkTargets('[a](web-MJNNMKH4ED)', () => 'https://x.org/a (b)')).toBe('[a](<https://x.org/a%20(b)>)');
    });

    it('exports a cited page as its title, URL and site', async () => {
        const { webCitationExport } = await import('@beaver/agent-core/identity/webPages');
        expect(webCitationExport({ url: 'https://www.who.int/x', title: 'Obesity', details: { kind: 'webpage', site: 'who.int', site_name: 'World Health Organization' } }))
            .toEqual({ url: 'https://www.who.int/x', title: 'Obesity', site: 'World Health Organization' });
        expect(webCitationExport({ url: 'https://who.int/x', details: { kind: 'webpage', site: 'who.int' } }))
            .toEqual({ url: 'https://who.int/x', title: 'who.int', site: null });
        expect(webCitationExport({ title: 'No URL' })).toBeNull();
    });

    it('writes a cited page as a Markdown link whose label and site stay literal text', async () => {
        const { webCitationMarkdown } = await import('@beaver/agent-core/identity/webPages');
        expect(webCitationMarkdown({ url: 'https://x.org/a', title: 'Paths like C:\\ and [brackets] *stars*', site: 'x_org' }))
            .toBe('([Paths like C:\\\\ and \\[brackets\\] \\*stars\\*](https://x.org/a), x\\_org)');
    });

    it('strips highlight sentence tags', async () => {
        const { stripHighlightTags } = await import('@beaver/agent-core/identity/webPages');
        expect(stripHighlightTags('<h1>One.</h1> two … <h12>Three.</h12>')).toBe('One. two … Three.');
        expect(stripHighlightTags('<h1>R&amp;D &lt;5% &amp;lt;</h1>')).toBe('R&D <5% &lt;');
    });
});

describe('web citation Markdown math', () => {
    it('keeps dollar signs in a title literal', async () => {
        const { webCitationMarkdown } = await import('@beaver/agent-core/identity/webPages');
        expect(webCitationMarkdown({ url: 'https://x.org/a', title: 'A $100 vs. $200 comparison', site: null }))
            .toBe('([A \\$100 vs. \\$200 comparison](https://x.org/a))');
    });
});
