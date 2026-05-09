import { defineConfig } from 'vitest/config';

// Smoke-tier config — opt-in, exercises real MuPDF WASM and sharp.
// Slower and more environment-sensitive than `npm test`, so kept out of
// the default unit run.
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
