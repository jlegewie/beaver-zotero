import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
        include: ['tests/unit/**/*.test.ts', 'tests/unit/**/*.test.tsx'],
        setupFiles: ['tests/setup.ts'],
        testTimeout: 10000,
    },
    resolve: {
        alias: {
            // Stub out imports that reference Zotero/React bundles
            // These are not needed in unit tests
        },
    },
});
