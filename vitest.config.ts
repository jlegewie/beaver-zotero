import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
        include: ['tests/**/*.test.ts'],
        exclude: ['tests/integration/**'],
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
