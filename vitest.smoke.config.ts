import { defineConfig } from 'vitest/config';
import 'dotenv/config';

// Smoke-tier config — opt-in, exercises real MuPDF WASM and sharp.
// Slower and more environment-sensitive than `npm test`, so kept out of
// the default unit run.
//
// `dotenv/config` is imported at the top of this file so `.env` is loaded
// into `process.env` before vitest collects tests. The fixture loaders read
// $BEAVER_EXTRACT_FIXTURES_DIR at module-import time, so a `setupFiles`
// entry would fire too late — vitest forks workers with the config-side
// `process.env` snapshot, which is what we need to mutate here.
export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
        include: ['tests/smoke/**/*.smoke.test.ts'],
        // No `setupFiles` — smoke tests want real Node, not the unit-tier
        // Mozilla-globals stubs in tests/setup.ts.
        testTimeout: 60000,
    },
});
