import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
        include: ['tests/live/**/*.live.test.ts'],
        // No setupFiles — live tests run against live Zotero, no stubs
        testTimeout: 15000,
        sequence: {
            concurrent: false,
        },
    },
});
