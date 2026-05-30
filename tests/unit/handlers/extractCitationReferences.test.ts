import { beforeEach, describe, expect, it, vi } from 'vitest';
import { extractCitationReferences } from '../../../src/services/agentDataProvider/actions/extractCitationReferences';

describe('extractCitationReferences', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        (globalThis as any).Zotero.Utilities.isValidObjectKey = vi.fn((key: string) => /^[A-Z0-9]{8}$/.test(key));
    });

    it('extracts Zotero references from legacy and unified citation tags', () => {
        const result = extractCitationReferences(
            '<citation att_id="1-ABCDEFGH"/> <citation id="2-IJKLMNOP" loc="p3"/> <citation external_id="W1"/>'
        );

        expect(result.references).toEqual([
            { library_id: 1, zotero_key: 'ABCDEFGH' },
            { library_id: 2, zotero_key: 'IJKLMNOP' },
        ]);
        expect(result.invalidKeys).toEqual([]);
    });

    it('reports malformed Zotero identities as invalid keys', () => {
        const result = extractCitationReferences(
            '<citation id="bad"/> <citation item_id="0-ABCDEFGH"/> <citation att_id="1-too-long-key"/>'
        );

        expect(result.references).toEqual([]);
        expect(result.invalidKeys).toEqual(['bad', '0-ABCDEFGH', '1-too-long-key']);
    });

    it('deduplicates valid and invalid references', () => {
        const result = extractCitationReferences(
            '<citation id="1-ABCDEFGH"/> <citation item_id="1-ABCDEFGH"/> '
            + '<citation id="bad"/> <citation att_id="bad"/>'
        );

        expect(result.references).toEqual([{ library_id: 1, zotero_key: 'ABCDEFGH' }]);
        expect(result.invalidKeys).toEqual(['bad']);
    });
});
