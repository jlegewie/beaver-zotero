import { SCHEMA_VERSION } from '@beaver/agent-core/extract/schema';
import { EPUB_SCHEMA_VERSION } from '@beaver/agent-core/extract/document/epub/schema';
import { SNAPSHOT_SCHEMA_VERSION } from '@beaver/agent-core/extract/document/snapshot/schema';
import type { ExtractContentKind } from '@beaver/agent-core/extract/document/shared/contentKinds';

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
