import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
        include: ['tests/integration/**/*.integration.test.ts'],
        // No setupFiles — integration tests run against live Zotero, no stubs
        testTimeout: 30000,
        sequence: {
            concurrent: false,
        },
    },
});
