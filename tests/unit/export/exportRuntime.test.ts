import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/utils/libraryIdentity', () => ({
    libraryRefForLibraryID: vi.fn(),
    resolveObjectId: vi.fn(),
}));

import { loadExportRuntime } from '../../../src/services/export/exportRuntime';

function fakeRuntime() {
    return {
        parseExportSource: vi.fn(),
        writeDocx: vi.fn(),
        writeHtml: vi.fn(),
        writeMarkdown: vi.fn(),
        writeLatex: vi.fn(),
        setObjectIdResolver: vi.fn(),
        setLibraryRefResolver: vi.fn(),
    };
}

describe('loadExportRuntime', () => {
    const originalServices = (globalThis as any).Services;
    let loadSubScriptWithOptions: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        vi.clearAllMocks();
        loadSubScriptWithOptions = vi.fn((_url: string, options: { target: Record<string, unknown> }) => {
            options.target.BeaverExportRuntime = fakeRuntime();
        });
        (globalThis as any).Services = { scriptloader: { loadSubScriptWithOptions } };
    });

    afterEach(() => {
        (globalThis as any).Services = originalServices;
    });

    it('loads the bundle from its chrome URL, bypassing the script cache', () => {
        const runtime = loadExportRuntime();
        expect(loadSubScriptWithOptions).toHaveBeenCalledWith(
            'chrome://beaver/content/scripts/beaver-export.js',
            expect.objectContaining({ ignoreCache: true }),
        );
        expect(runtime.setObjectIdResolver).toHaveBeenCalled();
        expect(runtime.setLibraryRefResolver).toHaveBeenCalled();
    });

    it('throws when the bundle does not expose the runtime', () => {
        loadSubScriptWithOptions.mockImplementation(() => {});
        expect(() => loadExportRuntime()).toThrow('The export runtime did not load');
    });
});
