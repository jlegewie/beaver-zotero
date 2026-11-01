import { normalizeCitationTag, parseRawCitationAttributes } from '@beaver/agent-core/citations/citationGrammar';
import type { ZoteroItemReference } from '@beaver/agent-core/types/zotero';
import { preloadExternalFileCitations } from '../../../utils/externalFileCitation';
import {
    buildUnresolvedLocatorWarning,
    ensureCitedLibrariesLoaded,
    expandNoteCitationTags,
    preloadPageLabelsForNewCitations,
    preloadStructuralLocatorPages,
    type ExternalRefContext,
} from '../../../utils/noteCitationExpand';
import { modelObjectIdFromReference } from '../../../utils/libraryIdentity';
import { maskRenderedCitationTags, unmaskNoteCitationTags } from '../../../utils/noteCitationMask';
import { noteCitationTagPattern } from '../../../utils/noteCitationTags';
import { wrapWithSchemaVersion } from '../../../utils/noteProvenance';
import { rebuildDataCitationItems } from '../../../utils/noteWrapper';
import type { SimplificationMetadata } from '../../../utils/noteHtmlSimplifier';
import { preloadStandaloneAttachmentLinks } from '../../../utils/zoteroLinkCitation';
import type { OperationContext } from '../operationContext';
import { checkLibraryExcluded } from '../utils';

/** `code` on errors for a citation tag that cannot be stored in a note. */
export const INVALID_NOTE_CITATION_CODE = 'invalid_citation';

/** Preload citation labels and files, and snapshot external-work mappings. */
export async function getExternalRefContext(content: string, context?: OperationContext): Promise<ExternalRefContext> {
    const [{ files, warnings }] = await Promise.all([
        preloadExternalFileCitations(content),
        preloadStandaloneAttachmentLinks(content, libraryID => !checkLibraryExcluded(libraryID)),
    ]);
    return {
        externalFiles: files,
        externalFileWarnings: warnings,
        externalRefs: context?.externalRefs ?? {},
        externalItemMapping: context?.externalItemMapping ?? {},
    };
}

/** A new note has no stored citations for a `ref` to point at. */
function noStoredCitations(): SimplificationMetadata {
    return { elements: new Map() };
}

function invalidCitationError(error: unknown): Error {
    const message = (error as Error | null)?.message || String(error);
    return Object.assign(new Error(message), { code: INVALID_NOTE_CITATION_CODE });
}

/**
 * Rewrite each external-reference tag that maps to a library item as a
 * citation of that item, keeping its locator. Expansion would cite the item
 * anyway; resolving it first lets the locator preloads (page labels,
 * structural pages) see the item too. Other tags are returned unchanged.
 */
function resolveMappedExternalTags(
    tags: string[],
    externalItemMapping: Record<string, ZoteroItemReference | null>,
): string[] {
    return tags.map((tag) => {
        const attrs = noteCitationTagPattern().exec(tag)?.[1];
        const normalized = normalizeCitationTag(parseRawCitationAttributes(attrs));
        if (!normalized.ok || normalized.ref.kind !== 'external') return tag;
        const mapped = externalItemMapping[normalized.ref.external_id];
        if (!mapped) return tag;
        const loc = normalized.ref.loc ? ` loc="${normalized.ref.loc.raw.replace(/"/g, '&quot;')}"` : '';
        return `<citation id="${modelObjectIdFromReference(mapped)}"${loc}/>`;
    });
}

/** Render note Markdown in a renderer; citations come back as tags. */
async function renderWithCitationTags(markdown: string, context?: OperationContext): Promise<string> {
    if (!context?.renderMarkdown) {
        throw Object.assign(new Error('Note rendering is unavailable'), { code: 'capability_unavailable' });
    }
    return context.renderMarkdown(markdown);
}

/**
 * Check that every citation in note Markdown can be stored. Renders the
 * Markdown as the write does, so a tag in a code example is never taken for a
 * citation, and runs the same expansion, so a citation that would fail the
 * write (unknown or excluded item, external work without a link, …) is
 * reported at validation instead.
 */
export async function checkNoteMarkdownCitations(
    markdown: string,
    context?: OperationContext,
): Promise<{ error: string | null; warnings: string[] }> {
    if (!/<citation\b/i.test(markdown)) return { error: null, warnings: [] };
    const { tags: rendered } = maskRenderedCitationTags(await renderWithCitationTags(markdown, context));
    if (rendered.length === 0) return { error: null, warnings: [] };

    const externalRefContext = await getExternalRefContext(rendered.join('\n'), context);
    const tags = resolveMappedExternalTags(rendered, externalRefContext.externalItemMapping);
    await ensureCitedLibrariesLoaded([tags.join('\n')]);
    const metadata = noStoredCitations();
    try {
        for (const tag of tags) expandNoteCitationTags(tag, metadata, 'new', externalRefContext);
    } catch (error) {
        return { error: invalidCitationError(error).message, warnings: [] };
    }
    return { error: null, warnings: externalRefContext.externalFileWarnings ?? [] };
}

/**
 * Render note Markdown (create_note content) to note HTML.
 *
 * The renderer leaves citations as `<citation …/>` tags (see
 * `OperationContext.renderMarkdown`); each is expanded here by the note
 * citation builder, the same one `edit_note` uses, so a citation is stored
 * identically however the note was written. Throws (with code
 * {@link INVALID_NOTE_CITATION_CODE}) when a citation cannot be stored, rather
 * than dropping it.
 */
export async function renderNoteMarkdown(
    markdown: string,
    context?: OperationContext,
): Promise<{ html: string; warnings: string[] }> {
    const masked = maskRenderedCitationTags(await renderWithCitationTags(markdown, context));
    if (masked.tags.length === 0) return { html: masked.text, warnings: [] };

    const externalRefContext = await getExternalRefContext(masked.tags.join('\n'), context);
    const tags = resolveMappedExternalTags(masked.tags, externalRefContext.externalItemMapping);
    const cited = tags.join('\n');
    await ensureCitedLibrariesLoaded([cited]);
    const pageLabels = await preloadPageLabelsForNewCitations(cited);
    const structuralLocators = await preloadStructuralLocatorPages(cited);
    const warnings = [...(externalRefContext.externalFileWarnings ?? [])];
    const locatorWarning = buildUnresolvedLocatorWarning(
        structuralLocators.unresolved,
        structuralLocators.unavailable,
        structuralLocators.missing,
    );
    if (locatorWarning) warnings.push(locatorWarning);

    const metadata = noStoredCitations();
    let expanded: string[];
    try {
        expanded = tags.map(tag => expandNoteCitationTags(
            tag, metadata, 'new', externalRefContext, pageLabels, structuralLocators.pages,
        ));
    } catch (error) {
        throw invalidCitationError(error);
    }
    return { html: unmaskNoteCitationTags(masked.text, masked, (_tag, index) => expanded[index]), warnings };
}

/**
 * Wrap rendered HTML as a new note's stored HTML: the schema-version wrapper
 * plus its `data-citation-items` cache. Note citations carry no inline
 * `itemData` (the form edits write, too); the wrapper cache is where Zotero
 * keeps it.
 */
export function wrapNewNoteHtml(html: string): string {
    return rebuildDataCitationItems(wrapWithSchemaVersion(html));
}
