import { build } from 'esbuild';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

async function bundle(bootstrap: string) {
    return build({
        stdin: {
            contents: `${bootstrap}
                export { resolveObjectIdReference, resolveLibraryRefForLibraryID } from '@beaver/agent-core/identity/libraryRef';
                export { normalizeCitationTag } from '@beaver/agent-core/citations/citationGrammar';`,
            resolveDir: process.cwd(),
        },
        bundle: true, write: false, format: 'iife', globalName: 'identityProbe', platform: 'browser',
        plugins: [{
            name: 'isolate-bootstrap-dependencies',
            setup(builder) {
                builder.onResolve({ filter: /^zotero-plugin-toolkit$/ }, () => ({ path: 'toolkit', namespace: 'fixture' }));
                builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export class BasicTool {}' }));
                // Keep the real plugin entry point and identity modules. Replace unrelated services.
                builder.onLoad({ filter: /\/src\/addon\.ts$/ }, () => ({
                    resolveDir: process.cwd(),
                    contents: `import { resolveObjectIdReference } from '@beaver/agent-core/identity/libraryRef';
                        export default class Addon {
                            constructor() {
                                this.identityAtConstruction = resolveObjectIdReference('g123-ABCDEFGH');
                                this.data = { ztoolkit: {} };
                            }
                        }`,
                }));
            },
        }],
    });
}

function realm() {
    const context = createContext({
        Zotero: {
            Libraries: { userLibraryID: 1 },
            Groups: {
                getLibraryIDFromGroupID: (id: number) => id === 123 ? 7 : null,
                getGroupIDFromLibraryID: (id: number) => id === 7 ? 123 : null,
            },
        },
    });
    runInContext('globalThis._globalThis = globalThis', context);
    return context;
}

describe('plugin identity bootstrap', () => {
    it('registers both resolvers before constructing services without using the renderer registry', async () => {
        const [rendererBundle, pluginBundle] = await Promise.all([
            bundle(`import { registerZoteroLibraryIdentity } from './src/utils/libraryIdentity'; registerZoteroLibraryIdentity();`),
            bundle(`import './src/index';`),
        ]);
        const renderer = realm();
        runInContext(rendererBundle.outputFiles[0].text, renderer);
        expect(renderer.identityProbe.resolveObjectIdReference('g123-ABCDEFGH').library_id).toBe(7);

        const plugin = realm();
        runInContext(pluginBundle.outputFiles[0].text, plugin);
        expect(plugin.Zotero.Beaver.identityAtConstruction.library_id).toBe(7);
        for (const [id, libraryId, ref] of [['u-ABCDEFGH', 1, 'u'], ['g123-ABCDEFGH', 7, 'g123']] as const) {
            expect(plugin.identityProbe.normalizeCitationTag({ id })).toMatchObject({
                ok: true, ref: { kind: 'zotero', library_id: libraryId, library_ref: ref, zotero_key: 'ABCDEFGH' },
            });
            expect(plugin.identityProbe.resolveLibraryRefForLibraryID(libraryId)).toBe(ref);
        }
        expect(plugin.identityProbe.resolveObjectIdReference('7-ABCDEFGH')).toMatchObject({ library_id: 7, library_ref: 'g123' });
    });
});
