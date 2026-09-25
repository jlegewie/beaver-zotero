import { SCHEMA_VERSION, type StructuredExtractResult } from '@beaver/agent-core/extract/schema';
import { schemaVersionForIdScheme } from '@beaver/agent-core/extract/ids';
import { locatorIdScheme, type Locator } from '@beaver/agent-core/citations/citationGrammar';
import { PRODUCIBLE_PDF_SCHEMA_VERSIONS } from '../../beaver-extract/schema/presets';
import type { ExtractionSource } from '../documentExtractionCore';
import { isCurrentExtractionSchemaVersion } from './shared/extractionSchemaVersions';

/**
 * The schema version a locator resolves against in a file. In a PDF, a
 * record-id locator names its version through its id scheme; every other
 * locator, and every locator in a non-PDF file (whose ids are unversioned),
 * resolves against the cached current result.
 */
export function locatorSchemaVersion(locator: Locator, isPdf: boolean): string {
    const scheme = isPdf ? locatorIdScheme(locator) : null;
    return scheme ? schemaVersionForIdScheme(scheme) : SCHEMA_VERSION;
}

/**
 * Structured result in one schema version, for resolving locators locally.
 *
 * The current version is read from the document cache only (a miss returns
 * `null`, never an extraction). A producible non-current PDF version is
 * extracted on demand without the cache. Any other version returns `null`.
 */
export async function structuredPdfResultForSchema(args: {
    source: ExtractionSource;
    /** Source file path, the document cache key for the current version. */
    filePath: string;
    schemaVersion: string;
}): Promise<StructuredExtractResult | null> {
    const { source, filePath, schemaVersion } = args;
    const ref = source.kind === 'zotero' ? source.item : source.itemRef;
    if (isCurrentExtractionSchemaVersion('pdf', schemaVersion)) {
        const result = await Zotero.Beaver?.documentCache?.getResult(
            { libraryId: ref.libraryID, zoteroKey: ref.key },
            'structured',
            filePath,
        );
        return result?.mode === 'structured' ? result : null;
    }
    if (!PRODUCIBLE_PDF_SCHEMA_VERSIONS.includes(schemaVersion)) return null;
    // Imported lazily so note-citation code, which imports this module, loads
    // the extraction core only when a locator needs an on-demand extraction.
    const { extractAndCacheResolvedPdfDocument } = await import('../documentExtractionCore');
    const extracted = await extractAndCacheResolvedPdfDocument({
        source,
        resolvedKey: `${ref.libraryID}-${ref.key}`,
        contentType: 'application/pdf',
        mode: 'structured',
        maxPages: null,
        timeoutSeconds: 0,
        workerName: 'hot',
        schemaVersion,
    });
    return extracted.kind === 'ok' && extracted.result?.mode === 'structured'
        ? extracted.result
        : null;
}
