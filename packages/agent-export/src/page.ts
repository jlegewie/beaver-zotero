/**
 * Paper size shared by the page-based writers, so a Word and a PDF export of
 * the same content come out on the same paper.
 */

/** A paper size setting: `auto` follows the citation locale. */
export type PaperSizeSetting = 'auto' | 'letter' | 'a4';

/** US Letter for US and Canadian English locales, A4 everywhere else. */
export function paperSize(locale: string, setting: PaperSizeSetting = 'auto'): 'letter' | 'a4' {
    if (setting !== 'auto') return setting;
    return /^en-(US|CA)$/i.test(locale) ? 'letter' : 'a4';
}
