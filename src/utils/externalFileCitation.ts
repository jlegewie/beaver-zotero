import { noteCitationTagPattern } from './noteCitationTags';
import {
    normalizeCitationTag,
    parseRawCitationAttributes,
    type Locator,
} from '@beaver/agent-core/citations/citationGrammar';
import { escapeAttr, unescapeAttr } from './noteHtmlEntities';

export interface ExternalFileCitationData {
    filename: string;
    /** URI of an existing managed copy on this computer. */
    href?: string;
}

/** Render a file reference without creating a Zotero/CSL citation. */
export function formatExternalFileCitationHTML(
    displayName: string,
    locatorSuffix: string,
    href?: string,
): string {
    const label = escapeAttr(displayName);
    const body = href ? `<a href="${escapeAttr(href)}">${label}</a>` : label;
    return `(${body}${escapeAttr(locatorSuffix)})`;
}

/** Preserve structural locators as structural locators, not page numbers. */
export function externalFileLocatorSuffix(loc?: Locator): string {
    if (!loc) return '';
    const value = unescapeAttr(loc.value);
    if (loc.kind === 'page') return `, p. ${value}`;
    return loc.kind === 'unknown' ? `, ${unescapeAttr(loc.raw)}` : `, ${loc.kind} ${value}`;
}

/** Load each cited file once; missing copies and metadata remain readable text. */
export async function preloadExternalFileCitations(content: string): Promise<{
    files: Record<string, ExternalFileCitationData>;
    warnings: string[];
}> {
    const keys = new Set<string>();
    const pattern = noteCitationTagPattern();
    for (const match of content.matchAll(pattern)) {
        const normalized = normalizeCitationTag(parseRawCitationAttributes(match[1] || ''));
        if (normalized.ok && normalized.ref.kind === 'external_file') keys.add(normalized.ref.ext_key);
    }
    const files: Record<string, ExternalFileCitationData> = {};
    const warnings: string[] = [];
    await Promise.all([...keys].map(async (key) => {
        let filename = `Attached file ext-${key}`;
        let href: string | undefined;
        let hasFilename = false;
        try {
            const record = await Zotero.Beaver?.db?.getExternalFileByKey(key);
            if (record?.filename) {
                filename = record.filename;
                hasFilename = true;
            }
            if (record?.storedPath && await IOUtils.exists(record.storedPath)) {
                href = Zotero.File.pathToFileURI(record.storedPath);
            }
        } catch {
            // File links are optional; retain the filename if it was loaded.
        }
        files[key] = { filename, ...(href ? { href } : {}) };
        if (!href) {
            warnings.push(hasFilename
                ? `External file ext-${key} is represented as filename-and-locator text because its local file link is unavailable.`
                : `External file ext-${key} has no available filename metadata or local file link; the reference uses its file ID and locator as plain text.`);
        }
    }));
    return { files, warnings };
}
