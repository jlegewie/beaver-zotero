import { readdirSync } from 'node:fs';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

/** Inputs of a browser bundle of `entryPoints` that belong to a renderer or to React. */
async function rendererInputs(entryPoints: string[]): Promise<string[]> {
    const result = await build({
        entryPoints, outdir: '/tmp/beaver-closure-check',
        bundle: true, platform: 'browser', format: 'iife',
        write: false, metafile: true, logLevel: 'silent',
    });
    return Object.keys(result.metafile!.inputs).filter(path =>
        path.startsWith('react/')
        || path.includes('/agent-ui/')
        || /node_modules\/(react|react-dom)\//.test(path)
        // The main `jotai` entry brings its React bindings; engine code uses `jotai/vanilla`.
        || /node_modules\/jotai\/(esm\/)?(index|react)/.test(path));
}

describe('instance provider dependency boundary', () => {
    it('bundles without a renderer store or React', async () => {
        expect(await rendererInputs(['src/services/zoteroDataProvider.ts', 'src/services/libraryOperations.ts'])).toEqual([]);
    });

    it('bundles the run engine without a renderer store or React', async () => {
        const engine = readdirSync('src/services/agentRuns')
            .filter(name => name.endsWith('.ts'))
            .map(name => `src/services/agentRuns/${name}`);
        expect(engine).toContain('src/services/agentRuns/runEngine.ts');
        expect(await rendererInputs(engine)).toEqual([]);
    });
});
