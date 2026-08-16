/**
 * Fail-fast guard on the Node version used to run the test suites.
 *
 * jsdom's CSS stack (`cssstyle` → `@asamuzakjp/css-color` → `@csstools/css-calc`)
 * is CommonJS that `require()`s an ES module. That only works on a Node with
 * `require(esm)` unflagged — Node >= 20.19.0, which is what `@csstools/css-calc`
 * declares in its own `engines`. On an older Node the require throws
 * `ERR_REQUIRE_ESM` deep inside jsdom, which surfaces as hundreds of unrelated
 * assertion failures across every DOM-touching suite (note normalization,
 * ProseMirror, the simplifier) plus a pile of "unhandled errors" — a failure mode
 * that reads exactly like broken product code.
 *
 * Throwing here instead turns that into one legible message before any test
 * loads. Imported for side effects by every `vitest.*.config.ts`, so it runs once
 * per test-suite invocation regardless of tier.
 */

const MINIMUM = [20, 19, 0];

function parseVersion(raw: string): number[] {
    return raw
        .replace(/^v/, '')
        .split('-')[0]
        .split('.')
        .map((part) => Number.parseInt(part, 10) || 0);
}

function isBelowMinimum(actual: number[]): boolean {
    for (let i = 0; i < MINIMUM.length; i++) {
        const value = actual[i] ?? 0;
        if (value > MINIMUM[i]) return false;
        if (value < MINIMUM[i]) return true;
    }
    return false;
}

export function assertNodeVersion(): void {
    const current = process.versions.node;
    if (!isBelowMinimum(parseVersion(current))) return;

    throw new Error(
        [
            '',
            `Beaver's test suites require Node >= ${MINIMUM.join('.')}, but this run is on v${current}.`,
            '',
            'jsdom require()s an ES module through its CSS stack, which needs a Node that',
            'supports require(esm). On an older Node that throws ERR_REQUIRE_ESM inside jsdom',
            'and every DOM-dependent suite fails with misleading assertion errors.',
            '',
            'Use the Node version CI uses (22.x), e.g.:',
            '  nvm use            # reads .nvmrc',
            '  PATH="$(brew --prefix node@22)/bin:$PATH" npm test',
            '',
        ].join('\n'),
    );
}

assertNodeVersion();
