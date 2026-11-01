import { SCHEMA_VERSION, type BeaverExtractResult } from '@beaver/agent-core/extract/schema';
import { EPUB_SCHEMA_VERSION } from '@beaver/agent-core/extract/document/epub/schema';
import { SNAPSHOT_SCHEMA_VERSION } from '@beaver/agent-core/extract/document/snapshot/schema';
import type { ExtractContentKind } from '@beaver/agent-core/extract/document/shared/contentKinds';
import type { ExtractSchemaVersionsWire } from '@beaver/agent-core/protocol/agentProtocol';
import { PRODUCIBLE_PDF_SCHEMA_VERSIONS } from '../../../beaver-extract/schema/presets';

export type { ExtractContentKind } from '@beaver/agent-core/extract/document/shared/contentKinds';

/**
 * Return the extraction schema version expected for cache rows of one content
 * kind, or `null` for kinds that are not cacheable yet.
 */
export function expectedExtractionSchemaVersion(kind: ExtractContentKind): string | null {
    switch (kind) {
        case 'pdf':
            return SCHEMA_VERSION;
        case 'epub':
            return EPUB_SCHEMA_VERSION;
        case 'snapshot':
            return SNAPSHOT_SCHEMA_VERSION;
        case 'text':
            return null;
    }
}

/**
 * Schema versions a document request may name for one content kind. Only PDF
 * can produce a version other than its current one; unversioned kinds
 * (`text`) produce none.
 */
export function producibleExtractionSchemaVersions(kind: ExtractContentKind): readonly string[] {
    if (kind === 'pdf') return PRODUCIBLE_PDF_SCHEMA_VERSIONS;
    const current = expectedExtractionSchemaVersion(kind);
    return current ? [current] : [];
}

/** True when a request names no schema version or the current one for `kind`. */
export function isCurrentExtractionSchemaVersion(
    kind: ExtractContentKind,
    requested: string | null | undefined,
): boolean {
    return requested == null || requested === expectedExtractionSchemaVersion(kind);
}

/**
 * Why a document request's `schema_version` cannot be served for this content
 * kind and mode, or `null` when it can. The current version is always served;
 * another producible version only in structured mode.
 */
export function unsupportedSchemaVersionMessage(
    kind: ExtractContentKind,
    requested: string | null | undefined,
    mode: BeaverExtractResult['mode'],
): string | null {
    if (requested == null || isCurrentExtractionSchemaVersion(kind, requested)) return null;
    const producible = producibleExtractionSchemaVersions(kind);
    if (producible.length === 0) {
        return `${kind} documents have no extraction schema version; schema_version must be omitted.`;
    }
    if (!producible.includes(requested)) {
        return `${kind} schema version ${requested} cannot be produced (producible: ${producible.join(', ')}).`;
    }
    return mode === 'structured'
        ? null
        : `${kind} schema version ${requested} is only available in structured mode.`;
}

/** The `extract_schema_versions` declaration sent at connect. */
export function extractSchemaVersionsDeclaration(): ExtractSchemaVersionsWire {
    return {
        pdf: { current: SCHEMA_VERSION, producible: [...PRODUCIBLE_PDF_SCHEMA_VERSIONS] },
        epub: { current: EPUB_SCHEMA_VERSION, producible: [EPUB_SCHEMA_VERSION] },
        snapshot: { current: SNAPSHOT_SCHEMA_VERSION, producible: [SNAPSHOT_SCHEMA_VERSION] },
    };
}
