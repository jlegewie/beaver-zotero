import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Fails the run early, with one legible message, on a Node too old for the
// require(esm) that jsdom's CSS stack performs. See the helper for why.
import './tests/helpers/assertNodeVersion';

const agentCoreSrc = fileURLToPath(new URL('./packages/agent-core/src', import.meta.url));
const agentUiSrc = fileURLToPath(new URL('./packages/agent-ui/src', import.meta.url));

export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
        include: ['tests/unit/**/*.test.ts'],
        setupFiles: ['tests/setup.ts'],
        testTimeout: 10000,
    },
    resolve: {
        alias: {
            '@beaver/agent-core': agentCoreSrc,
            '@beaver/agent-ui': agentUiSrc,
        },
    },
});
