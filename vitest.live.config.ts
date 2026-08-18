import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const agentCoreSrc = fileURLToPath(new URL('./packages/agent-core/src', import.meta.url));
const agentUiSrc = fileURLToPath(new URL('./packages/agent-ui/src', import.meta.url));

export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
        include: ['tests/live/**/*.live.test.ts'],
        // No stubs — live tests run against live Zotero. These two only
        // normalize the instance's excluded-libraries set (see
        // tests/helpers/liveExclusions.ts): once per run, and again at the
        // start of each file so a leak stays contained to its own file.
        globalSetup: ['tests/helpers/liveGlobalSetup.ts'],
        setupFiles: ['tests/helpers/liveSetupFile.ts'],
        testTimeout: 15000,
        sequence: {
            concurrent: false,
        },
        // Live tests share one Zotero instance and mutate global state
        // (document cache, MuPDF worker). Running files in parallel races
        // those endpoints, so execute every file sequentially.
        fileParallelism: false,
    },
    resolve: {
        alias: {
            '@beaver/agent-core': agentCoreSrc,
            '@beaver/agent-ui': agentUiSrc,
        },
    },
});
