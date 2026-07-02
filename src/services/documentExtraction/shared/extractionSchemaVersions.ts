import { SCHEMA_VERSION } from '../../../beaver-extract/schema/schema';
import { EPUB_SCHEMA_VERSION } from '../epub/schema';
import { SNAPSHOT_SCHEMA_VERSION } from '../snapshot/schema';
import type { ExtractContentKind } from './contentKinds';

export type { ExtractContentKind } from './contentKinds';

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
