import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION } from '../../../src/beaver-extract/schema/schema';
import { EPUB_SCHEMA_VERSION } from '../../../src/services/documentExtraction/epub/schema';
import { SNAPSHOT_SCHEMA_VERSION } from '../../../src/services/documentExtraction/snapshot/schema';
import { expectedExtractionSchemaVersion } from '../../../src/services/documentExtraction/shared/extractionSchemaVersions';

describe('expectedExtractionSchemaVersion', () => {
    it('returns per-kind cache schema versions', () => {
        expect(expectedExtractionSchemaVersion('pdf')).toBe(SCHEMA_VERSION);
        expect(expectedExtractionSchemaVersion('epub')).toBe(EPUB_SCHEMA_VERSION);
        expect(expectedExtractionSchemaVersion('snapshot')).toBe(SNAPSHOT_SCHEMA_VERSION);
        expect(expectedExtractionSchemaVersion('text')).toBeNull();
    });
});
