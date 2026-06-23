import { describe, expect, it } from 'vitest';
import {
    createPreparedJsonMessage,
    isPreparedJsonMessage,
    materializePreparedJsonMessage,
    withPreparedJsonEnvelope,
} from '../../../src/services/preparedJsonMessage';

describe('preparedJsonMessage', () => {
    it('splices raw JSON fields into a small serialized envelope', () => {
        const prepared = createPreparedJsonMessage(
            { type: 'zotero_document', request_id: 'r1' },
            { result: '{"content_kind":"pdf","mode":"structured"}' },
        );

        expect(isPreparedJsonMessage(prepared)).toBe(true);
        expect(JSON.parse(materializePreparedJsonMessage(prepared))).toEqual({
            type: 'zotero_document',
            request_id: 'r1',
            result: {
                content_kind: 'pdf',
                mode: 'structured',
            },
        });
    });

    it('updates only the envelope while preserving raw fields', () => {
        const prepared = createPreparedJsonMessage(
            { type: 'zotero_document', request_id: 'r1' },
            { result: '{"content_kind":"pdf"}' },
        );
        const updated = withPreparedJsonEnvelope(prepared, (envelope) => ({
            ...envelope,
            timing: { total_ms: 12 },
        }));

        expect(JSON.parse(materializePreparedJsonMessage(updated))).toMatchObject({
            timing: { total_ms: 12 },
            result: { content_kind: 'pdf' },
        });
    });
});
