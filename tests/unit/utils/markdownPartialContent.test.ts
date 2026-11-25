import { describe, expect, it } from 'vitest';
import { processPartialContent } from '@beaver/agent-export/render/partialContent';

describe('processPartialContent', () => {
    it.each([false, true])('keeps the zero-width non-joiner of Persian words (export: %s)', (exportRendering) => {
        // ZWNJ after a letter, and after a letter carrying a vowel mark.
        const persian = 'این روش نتایج بهتری می\u200Cدهد و دقیق\u200Cتر است. بِ\u200Cکار';
        expect(processPartialContent(persian, exportRendering)).toBe(persian);
    });

    it.each([false, true])('removes invisible characters outside Arabic-script words (export: %s)', (exportRendering) => {
        expect(processPartialContent('<\u200Ccitation id="1"/> text', exportRendering))
            .toBe('<citation id="1"/> text');
        expect(processPartialContent('a\u200Db\u200Bc\uFEFFd\u00ADe', exportRendering)).toBe('abcde');
        expect(processPartialContent('می\u200Bدهد', exportRendering)).toBe('میدهد');
        // Arabic-Indic digits are Arabic script but not letters.
        expect(processPartialContent('١٢\u200C٣', exportRendering)).toBe('١٢٣');
    });

    it('preserves completed display math followed by prose', () => {
        const content = [
            'The actual array response becomes:',
            '',
            '$$\\mathbf{s}_r(r) = \\mathbf{C} \\cdot \\mathbf{s}_{r,id}(r)$$',
            '',
            'This means the effective array pattern deviates from the nominal design.',
            '',
            '## Sources',
            '',
            'Schmid, Christian M.',
        ].join('\n');

        const result = processPartialContent(content, false);

        expect(result).toContain('$$\\mathbf{s}_r(r) = \\mathbf{C} \\cdot \\mathbf{s}_{r,id}(r)$$');
        expect(result).toContain('This means the effective array pattern deviates');
        expect(result).toContain('## Sources');
    });

    it('preserves completed multiline display math followed by prose', () => {
        const content = [
            'Equation:',
            '',
            '$$',
            '\\mathbf{s}_r(r) = \\mathbf{C} \\cdot \\mathbf{s}_{r,id}(r)',
            '$$',
            '',
            'The next paragraph remains visible.',
        ].join('\n');

        const result = processPartialContent(content, false);

        expect(result).toBe(content);
    });

    it('strips a trailing incomplete inline display math fragment', () => {
        const content = 'The actual array response becomes:\n\n$$\\mathbf{s}_r(r)';

        const result = processPartialContent(content, false);

        expect(result).toBe('The actual array response becomes:\n\n');
    });

    it('strips a trailing incomplete multiline display math block', () => {
        const content = [
            'Equation:',
            '',
            '$$',
            '\\mathbf{s}_r(r) = \\mathbf{C}',
        ].join('\n');

        const result = processPartialContent(content, false);

        expect(result).toBe('Equation:\n\n');
    });
});
