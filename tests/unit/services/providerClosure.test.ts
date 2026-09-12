import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

describe('instance provider dependency boundary', () => {
    it('bundles without a renderer store or React', async () => {
        const result = await build({
            entryPoints: ['src/services/zoteroDataProvider.ts', 'src/services/libraryOperations.ts'], outdir: '/tmp/beaver-closure-check',
            bundle: true, platform: 'browser', format: 'iife',
            write: false, metafile: true, logLevel: 'silent',
        });
        const inputs = Object.keys(result.metafile!.inputs);
        expect(inputs.filter(path => path.startsWith('react/') || path.includes('/agent-ui/') || /node_modules\/(react|react-dom)\//.test(path))).toEqual([]);
    });
});
