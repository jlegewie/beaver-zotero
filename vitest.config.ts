import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const agentCoreSrc = fileURLToPath(new URL('./packages/agent-core/src', import.meta.url));
const agentUiSrc = fileURLToPath(new URL('./packages/agent-ui/src', import.meta.url));
const agentExportSrc = fileURLToPath(new URL('./packages/agent-export/src', import.meta.url));

export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
        // Worker threads start far faster than forked processes, and module
        // collection dominates this suite's runtime.
        pool: 'threads',
        poolOptions: {
            threads: {
                // Node 22 flags `node:sqlite`, which backs MockDBConnection, as
                // experimental and warns once in every worker that loads it.
                execArgv: ['--disable-warning=ExperimentalWarning'],
            },
        },
        include: ['tests/unit/**/*.test.ts'],
        setupFiles: ['tests/setup.ts'],
        // Keeps native addons loaded in the main process; see the file.
        globalSetup: ['tests/helpers/nativeAddonsGlobalSetup.ts'],
        testTimeout: 10000,
    },
    resolve: {
        alias: {
            '@beaver/agent-core': agentCoreSrc,
            '@beaver/agent-ui': agentUiSrc,
            '@beaver/agent-export': agentExportSrc,
        },
    },
});
