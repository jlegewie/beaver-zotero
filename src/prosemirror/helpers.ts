/**
 * Utility functions for the Zotero note-editor ProseMirror schema.
 * Adapted from zotero/note-editor src/core/utils.js (AGPL-3.0).
 *
 * Only the functions needed by the schema layer are included here:
 * encodeObject, decodeObject, randomString, formatCitationItem.
 */

export function encodeObject(value: unknown): string | null {
    if (typeof value !== 'object') {
        return null;
    }
    return encodeURIComponent(JSON.stringify(value));
}

export function decodeObject(value: string | null | undefined): any {
    try {
        return JSON.parse(decodeURIComponent(value!));
    }
    catch (e) {
        // Intentionally swallow — invalid/missing data returns null
    }
    return null;
}

export function randomString(len?: number, chars?: string): string {
    if (!chars) {
        chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
    }
    if (!len) {
        len = 8;
    }
    let result = '';
    for (let i = 0; i < len; i++) {
        const rnum = Math.floor(Math.random() * chars.length);
        result += chars.substring(rnum, rnum + 1);
    }
    return result;
}

/**
 * Build citation item preview string.
 * Based on _buildBubbleString in Zotero's quickFormat.js.
 *
 * The original calls getLocalizedString() for "and" / "et al." with
 * fallbacks. We use the English fallbacks directly since this is only
 * used for serialization display text in normalization.
 */
export function formatCitationItem(citationItem: any): string {
    const STARTSWITH_ROMANESQUE_REGEXP = /^[&a-zA-Z\u0e01-\u0e5b\u00c0-\u017f\u0370-\u03ff\u0400-\u052f\u0590-\u05d4\u05d6-\u05ff\u1f00-\u1fff\u0600-\u06ff\u200c\u200d\u200e\u0218\u0219\u021a\u021b\u202a-\u202e]/;
    const ENDSWITH_ROMANESQUE_REGEXP = /[.;:&a-zA-Z\u0e01-\u0e5b\u00c0-\u017f\u0370-\u03ff\u0400-\u052f\u0590-\u05d4\u05d6-\u05ff\u1f00-\u1fff\u0600-\u06ff\u200c\u200d\u200e\u0218\u0219\u021a\u021b\u202a-\u202e]$/;

    const { itemData } = citationItem;
    let str = '';

    if (!itemData) {
        return '';
    }

    // Authors
    const authors = itemData.author;
    if (authors) {
        if (authors.length === 1) {
            str = authors[0].family || authors[0].literal;
        }
        else if (authors.length === 2) {
            const a = authors[0].family || authors[0].literal;
            const b = authors[1].family || authors[1].literal;
            str = a + ' and ' + b;
        }
        else if (authors.length >= 3) {
            str = (authors[0].family || authors[0].literal) + ' et al.';
        }
    }

    // Title
    if (!str && itemData.title) {
        str = `"${itemData.title}"`;
    }

    // Date
    if (itemData.issued
        && itemData.issued['date-parts']
        && itemData.issued['date-parts'][0]) {
        const year = itemData.issued['date-parts'][0][0];
        if (year && year != '0000') {
            str += ', ' + year;
        }
    }

    // Locator
    if (citationItem.locator) {
        let label: string;
        if (citationItem.label) {
            label = citationItem.label;
        }
        else if (/[\-\u2013,]/.test(citationItem.locator)) {
            label = 'pp.';
        }
        else {
            label = 'p.';
        }

        str += ', ' + label + ' ' + citationItem.locator;
    }

    // Prefix
    if (citationItem.prefix && ENDSWITH_ROMANESQUE_REGEXP) {
        str = citationItem.prefix
            + (ENDSWITH_ROMANESQUE_REGEXP.test(citationItem.prefix) ? ' ' : '')
            + str;
    }

    // Suffix
    if (citationItem.suffix && STARTSWITH_ROMANESQUE_REGEXP) {
        str += (STARTSWITH_ROMANESQUE_REGEXP.test(citationItem.suffix) ? ' ' : '')
            + citationItem.suffix;
    }

    return str;
}
