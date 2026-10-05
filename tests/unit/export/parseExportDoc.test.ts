import { describe, expect, it } from 'vitest';
import { parseExportSource } from '@beaver/agent-export/parse/parseExportDoc';

const parse = (markdown: string) => parseExportSource({ title: 'T', blocks: [{ type: 'markdown', markdown }] });

describe('parseExportSource', () => {
    it('merges adjacent citation tags into one cluster and drops duplicates within it', () => {
        const doc = parse('Claim <citation id="u-AAAAAAAA" loc="page3"/> <citation id="u-BBBBBBBB"/><citation id="u-BBBBBBBB"/>.');
        expect(doc.clusters).toHaveLength(1);
        expect(doc.clusters[0].items.map(item => item.requestedKey)).toEqual(['zotero:u-AAAAAAAA:page3', 'zotero:u-BBBBBBBB']);
        const paragraph = doc.sections[0].children[0] as any;
        expect(paragraph.children.map((node: any) => node.type)).toEqual(['text', 'citation', 'text']);
    });

    it('keeps citations separated by text as separate clusters, in document order', () => {
        const doc = parse('A <citation id="u-AAAAAAAA"/> and B <citation id="u-BBBBBBBB"/>\n\n- item <citation id="u-CCCCCCCC"/>');
        expect(doc.clusters.map(cluster => cluster.index)).toEqual([0, 1, 2]);
        expect(doc.clusters[2].items[0].requestedKey).toBe('zotero:u-CCCCCCCC');
    });

    it('finds citations inside emphasis and table cells', () => {
        const doc = parse('*see <citation id="u-AAAAAAAA"/>*\n\n| a |\n|---|\n| x <citation id="u-BBBBBBBB"/> |');
        expect(doc.clusters).toHaveLength(2);
    });

    it('keeps a citation tag inside a code block as literal text', () => {
        const doc = parse('Example:\n\n```\n<citation id="u-BBBBBBBB"/>\n```');
        expect(doc.clusters).toHaveLength(0);
        const code = doc.sections[0].children[1] as any;
        expect(code.value).toBe('<citation id="u-BBBBBBBB"/>');
    });

    it('unwraps backtick-wrapped citations', () => {
        expect(parse('Claim `<citation id="u-AAAAAAAA"/>`.').clusters).toHaveLength(1);
    });

    it('records unparseable tags with their fallback key', () => {
        const doc = parse('Bad <citation id="garbage"/>.');
        expect(doc.clusters[0].items[0]).toMatchObject({ ref: null, invalidKey: 'invalid:garbage' });
    });

    it('converts LaTeX delimiters and treats a lone $$…$$ paragraph as display math', () => {
        const doc = parse('Inline \\(x^2\\) here.\n\n$$a = b$$\n\n\\[c = d\\]');
        const [paragraph, display, bracket] = doc.sections[0].children as any[];
        expect(paragraph.children.some((node: any) => node.type === 'inlineMath' && node.value === 'x^2')).toBe(true);
        expect(display).toMatchObject({ type: 'math', value: 'a = b' });
        expect(bracket).toMatchObject({ type: 'math', value: 'c = d' });
    });

    it('numbers clusters across sections', () => {
        const doc = parseExportSource({ title: 'T', blocks: [
            { type: 'markdown', markdown: 'A <citation id="u-AAAAAAAA"/>' },
            { type: 'note', title: 'N', markdown: 'B <citation id="u-BBBBBBBB"/>' },
        ] });
        expect(doc.sections.map(section => section.kind)).toEqual(['markdown', 'note']);
        expect(doc.sections[1].title).toBe('N');
        expect(doc.clusters).toHaveLength(2);
    });

    it('resolves reference-style links against their definitions', () => {
        const doc = parse('Read [the study][s] and [nothing][missing].\n\n[s]: https://example.com\n\nCollapsed [s][] too.');
        expect(doc.sections[0].children).toHaveLength(2);
        expect((doc.sections[0].children[1] as any).children[1]).toMatchObject({ type: 'link', url: 'https://example.com' });
        const paragraph = doc.sections[0].children[0] as any;
        expect(paragraph.children).toEqual([
            expect.objectContaining({ type: 'text', value: 'Read ' }),
            expect.objectContaining({ type: 'link', url: 'https://example.com', children: [expect.objectContaining({ value: 'the study' })] }),
            // Without a definition CommonMark keeps the brackets as text.
            expect.objectContaining({ type: 'text', value: ' and [nothing][missing].' }),
        ]);
    });

    it('leaves LaTeX delimiters inside code untouched', () => {
        const doc = parse('Use `\\(x\\)` inline.\n\n```tex\n\\[a\\] and \\(b\\)\n```\n\nBut \\(c\\) is math.');
        const [inline, fence, math] = doc.sections[0].children as any[];
        expect(inline.children[1]).toMatchObject({ type: 'inlineCode', value: '\\(x\\)' });
        expect(fence).toMatchObject({ type: 'code', value: '\\[a\\] and \\(b\\)' });
        expect(math.children.some((node: any) => node.type === 'inlineMath' && node.value === 'c')).toBe(true);
    });

    it('leaves LaTeX delimiters in indented code and multi-backtick spans untouched', () => {
        const doc = parse('Text.\n\n    \\(x\\) indented\n\nA ``a ` \\(y\\)`` span and \\(z\\).');
        const [, indented, paragraph] = doc.sections[0].children as any[];
        expect(indented).toMatchObject({ type: 'code', value: '\\(x\\) indented' });
        expect(paragraph.children[1]).toMatchObject({ type: 'inlineCode', value: 'a ` \\(y\\)' });
        expect(paragraph.children.some((node: any) => node.type === 'inlineMath' && node.value === 'z')).toBe(true);
    });

    it('converts multiline bracket display math without losing its first line', () => {
        const doc = parse('Before\n\\[a +\nb\\]\nAfter');
        const blocks = doc.sections[0].children as any[];
        expect(blocks.find(block => block.type === 'math')).toMatchObject({ value: 'a +\nb' });
        expect(JSON.stringify(blocks)).toContain('After');
    });

    it('keeps citations inside raw HTML blocks', () => {
        const doc = parse('<p>Claim <citation id="u-AAAAAAAA"/> &amp; more.</p>\n<p>Second <citation id="u-BBBBBBBB"/>.</p>');
        expect(doc.clusters.map(cluster => cluster.items[0].requestedKey)).toEqual(['zotero:u-AAAAAAAA', 'zotero:u-BBBBBBBB']);
        const paragraphs = doc.sections[0].children as any[];
        expect(paragraphs).toHaveLength(2);
        expect(paragraphs[0].children).toEqual([
            { type: 'text', value: 'Claim ' },
            { type: 'citation', clusterIndex: 0 },
            { type: 'text', value: ' & more.' },
        ]);
    });

    it('turns raw HTML blocks into decoded paragraphs with their line breaks', () => {
        const doc = parse('<p>A &amp; B</p><p>C<br>D\n  wrapped</p>');
        expect(doc.sections[0].children).toEqual([
            { type: 'paragraph', children: [{ type: 'text', value: 'A & B' }] },
            { type: 'paragraph', children: [{ type: 'text', value: 'C' }, { type: 'break' }, { type: 'text', value: 'D wrapped' }] },
        ]);
    });

    it('resolves link definitions written in another part of the response', () => {
        const doc = parseExportSource({ title: '', blocks: [
            { type: 'markdown', markdown: 'See [the study][s].' },
            { type: 'activity', calls: ['Item search'] },
            { type: 'markdown', markdown: 'Done.\n\n[s]: https://example.com' },
        ] });
        const paragraph = doc.sections[0].children[0] as any;
        expect(paragraph.children[1]).toMatchObject({ type: 'link', url: 'https://example.com' });
    });

    it('keeps activity markers out of content that swallowed them', () => {
        const doc = parseExportSource({ title: '', blocks: [
            { type: 'markdown', markdown: 'Example:\n\n```\ncode' },
            { type: 'activity', calls: ['Item search'] },
            { type: 'markdown', markdown: 'After.' },
        ] });
        expect(JSON.stringify(doc.sections)).not.toContain('\uE003');
        const code = doc.sections[0].children.find(node => node.type === 'code') as any;
        expect(code.value).toBe('code\n\nAfter.');
        expect(doc.sections.map(section => section.kind)).toEqual(['markdown', 'activity']);
    });
});
