import { afterEach, describe, expect, it } from 'vitest';

import {
    DEFAULT_MAX_FILE_SIZE_MB,
    HARD_ATTACHMENT_LIMITS,
    SNAPSHOT_HARD_MAX_FILE_SIZE_MB,
    effectiveMaxFileSizeMB,
    effectiveMaxPageCount,
    effectiveMaxSnapshotFileSizeMB,
} from '@beaver/agent-core/transport/attachmentLimits';
import {
    getRuntimeAdapter,
    setRuntimeAdapter,
    type RuntimeAdapter,
} from '@beaver/agent-core/platform/runtime';

const { maxPageCount } = HARD_ATTACHMENT_LIMITS;
const pristineAdapter = getRuntimeAdapter();

/** Install an adapter whose only job is to answer the file-size preference. */
function withPrefValue(value: unknown): void {
    setRuntimeAdapter({
        ...pristineAdapter,
        getPluginPref: () => value,
    } as RuntimeAdapter);
}

describe('attachmentLimits', () => {
    afterEach(() => {
        setRuntimeAdapter(pristineAdapter);
    });

    it('exposes positive defaults and caps', () => {
        expect(DEFAULT_MAX_FILE_SIZE_MB).toBeGreaterThan(0);
        expect(maxPageCount).toBeGreaterThan(0);
    });

    it('falls back to the default file size when the host exposes no preference', () => {
        expect(effectiveMaxFileSizeMB()).toBe(DEFAULT_MAX_FILE_SIZE_MB);
    });

    it('uses the preference value, above or below the default', () => {
        withPrefValue(25);
        expect(effectiveMaxFileSizeMB()).toBe(25);

        withPrefValue(DEFAULT_MAX_FILE_SIZE_MB + 150);
        expect(effectiveMaxFileSizeMB()).toBe(DEFAULT_MAX_FILE_SIZE_MB + 150);
    });

    it('falls back to the default for unusable preference values', () => {
        for (const value of [0, -1, Number.NaN, null, undefined, '50', {}]) {
            withPrefValue(value);
            expect(effectiveMaxFileSizeMB()).toBe(DEFAULT_MAX_FILE_SIZE_MB);
        }
    });

    it('bounds the snapshot ceiling by the snapshot hard cap', () => {
        withPrefValue(500);
        expect(effectiveMaxSnapshotFileSizeMB()).toBe(SNAPSHOT_HARD_MAX_FILE_SIZE_MB);

        withPrefValue(20);
        expect(effectiveMaxSnapshotFileSizeMB()).toBe(20);
    });

    it('uses the hard page-count cap when no caller-specific limit is provided', () => {
        expect(effectiveMaxPageCount()).toBe(maxPageCount);
    });

    it('keeps stricter caller-specific page-count limits', () => {
        expect(effectiveMaxPageCount(300)).toBe(300);
    });

    it('clamps caller-specific page-count limits to the hard cap', () => {
        expect(effectiveMaxPageCount(maxPageCount + 2000)).toBe(maxPageCount);
    });

    it('ignores invalid caller-specific page-count limits', () => {
        expect(effectiveMaxPageCount(-1)).toBe(maxPageCount);
        expect(effectiveMaxPageCount(null)).toBe(maxPageCount);
    });
});
