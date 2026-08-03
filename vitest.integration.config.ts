import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const agentCoreSrc = fileURLToPath(new URL('./packages/agent-core/src', import.meta.url));

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
    resolve: {
        alias: {
            '@beaver/agent-core': agentCoreSrc,
        },
    },
});
