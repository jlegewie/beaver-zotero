import { describe, it, expect, beforeEach, vi } from 'vitest';

const FILE_FLAVOR = 'application/x-moz-file';

/** Flavors the fake clipboard currently reports, and the data behind them. */
let clipboardFlavors: string[] = [];
let clipboardFile: { path: string } | null = null;
let clipboardImageBytes: number[] | null = null;
/** Set to a flavor to make `getTransferData` throw for it. */
let unreadableFlavor: string | null = null;

const clipboard = {
    kGlobalClipboard: 1,
    hasDataMatchingFlavors: vi.fn((flavors: string[]) => flavors.some((f) => clipboardFlavors.includes(f))),
    getData: vi.fn(),
};

function installMozillaGlobals() {
    (globalThis as any).Services = { clipboard };

    const transferableFactory = {
        createInstance: () => {
            let flavor = '';
            return {
                init: () => {},
                addDataFlavor: (f: string) => { flavor = f; },
                getTransferData: (requested: string, out: { value?: unknown }) => {
                    if (requested !== flavor || requested === unreadableFlavor) {
                        throw new Error('NS_ERROR_FAILURE');
                    }
                    if (requested === FILE_FLAVOR) {
                        if (!clipboardFile) throw new Error('NS_ERROR_FAILURE');
                        out.value = { QueryInterface: () => clipboardFile };
                        return;
                    }
                    if (!clipboardImageBytes) throw new Error('NS_ERROR_FAILURE');
                    out.value = { QueryInterface: () => ({ isStream: true }) };
                },
            };
        },
    };

    const binaryStreamFactory = {
        createInstance: () => ({
            setInputStream: () => {},
            available: () => clipboardImageBytes?.length ?? 0,
            readByteArray: () => clipboardImageBytes ?? [],
        }),
    };

    (globalThis as any).Components = {
        classes: {
            '@mozilla.org/widget/transferable;1': transferableFactory,
            '@mozilla.org/binaryinputstream;1': binaryStreamFactory,
        },
        interfaces: {
            nsITransferable: 'nsITransferable',
            nsIFile: 'nsIFile',
            nsIInputStream: 'nsIInputStream',
            nsIBinaryInputStream: 'nsIBinaryInputStream',
        },
    };

    (globalThis as any).Zotero.getTempDirectory = vi.fn(() => ({ path: '/tmp/zotero' }));
    (globalThis as any).Zotero.File.getValidFileName = vi.fn((name: string) => name.replace(/[/\\:]/g, '_'));
    (globalThis as any).PathUtils.parent = vi.fn((path: string) => {
        const segments = path.split('/');
        segments.pop();
        return segments.join('/');
    });
    // Gecko's PathUtils only accepts absolute paths and throws otherwise; the
    // shared stub is more forgiving, which would hide a relative-path misuse.
    (globalThis as any).PathUtils.filename = vi.fn((path: string) => {
        if (!path.startsWith('/')) throw new Error('NS_ERROR_FILE_UNRECOGNIZED_PATH');
        return path.split('/').pop();
    });
}

/** A pasted File stand-in; only `name`, `type`, and `arrayBuffer` are read. */
function fakeFile(name: string, type: string, bytes = [1, 2, 3]): File {
    return {
        name,
        type,
        arrayBuffer: async () => new Uint8Array(bytes).buffer,
    } as unknown as File;
}

async function loadModule() {
    vi.resetModules();
    return import('../../../src/services/clipboardFiles');
}

describe('clipboardFiles', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        clipboardFlavors = [];
        clipboardFile = null;
        clipboardImageBytes = null;
        unreadableFlavor = null;
        installMozillaGlobals();
    });

    describe('clipboardHasFile', () => {
        it('reports a file copied in a file manager', async () => {
            clipboardFlavors = [FILE_FLAVOR];
            const { clipboardHasFile } = await loadModule();
            expect(clipboardHasFile()).toBe(true);
        });

        it('is false for a text clipboard, so ordinary paste is untouched', async () => {
            clipboardFlavors = ['text/plain'];
            const { clipboardHasFile } = await loadModule();
            expect(clipboardHasFile()).toBe(false);
        });

        it('is false when the clipboard service throws', async () => {
            clipboard.hasDataMatchingFlavors.mockImplementationOnce(() => {
                throw new Error('no clipboard');
            });
            const { clipboardHasFile } = await loadModule();
            expect(clipboardHasFile()).toBe(false);
        });
    });

    describe('readClipboardFilePath', () => {
        it('returns the path of the file on the clipboard', async () => {
            clipboardFlavors = [FILE_FLAVOR];
            clipboardFile = { path: '/Users/me/Documents/paper.pdf' };
            const { readClipboardFilePath } = await loadModule();
            expect(readClipboardFilePath()).toBe('/Users/me/Documents/paper.pdf');
        });

        it('returns null when the flavor cannot be read', async () => {
            clipboardFlavors = [FILE_FLAVOR];
            unreadableFlavor = FILE_FLAVOR;
            const { readClipboardFilePath } = await loadModule();
            expect(readClipboardFilePath()).toBeNull();
        });
    });

    describe('writePastedFileToTemp', () => {
        it('renames a clipboard image, whose placeholder name would reach the model', async () => {
            const { writePastedFileToTemp } = await loadModule();
            const path = await writePastedFileToTemp(fakeFile('image.png', 'image/png'));
            expect(path).toMatch(/\/pasted-image-\d+\.png$/);
            expect(IOUtils.write).toHaveBeenCalledTimes(1);
        });

        it('derives the extension from the image type', async () => {
            const { writePastedFileToTemp } = await loadModule();
            const path = await writePastedFileToTemp(fakeFile('image.jpeg', 'image/jpeg'));
            expect(path).toMatch(/\.jpg$/);
        });

        it('keeps a non-image file name, sanitized', async () => {
            const { writePastedFileToTemp } = await loadModule();
            const path = await writePastedFileToTemp(fakeFile('my paper.pdf', 'application/pdf'));
            expect(path).toMatch(/\/my paper\.pdf$/);
        });

        it('strips directory separators from the reported name', async () => {
            const { writePastedFileToTemp } = await loadModule();
            const path = await writePastedFileToTemp(fakeFile('sub/dir/paper.pdf', 'application/pdf'));
            expect(path).toMatch(/\/paper\.pdf$/);
        });

        it('gives each write its own folder so names cannot collide', async () => {
            const { writePastedFileToTemp } = await loadModule();
            const first = await writePastedFileToTemp(fakeFile('paper.pdf', 'application/pdf'));
            const second = await writePastedFileToTemp(fakeFile('paper.pdf', 'application/pdf'));
            expect(first).not.toBe(second);
            expect(PathUtils.parent(first!)).not.toBe(PathUtils.parent(second!));
        });

        it('returns null when the bytes cannot be read', async () => {
            const { writePastedFileToTemp } = await loadModule();
            const broken = {
                name: 'image.png',
                type: 'image/png',
                arrayBuffer: async () => { throw new Error('gone'); },
            } as unknown as File;
            expect(await writePastedFileToTemp(broken)).toBeNull();
        });
    });

    describe('readClipboardImageToTemp', () => {
        it('spills clipboard image bytes to a temp file', async () => {
            clipboardFlavors = ['image/png'];
            clipboardImageBytes = [137, 80, 78, 71];
            const { readClipboardImageToTemp } = await loadModule();
            const path = await readClipboardImageToTemp();
            expect(path).toMatch(/\/pasted-image-\d+\.png$/);
            expect(IOUtils.write).toHaveBeenCalledWith(path, new Uint8Array([137, 80, 78, 71]));
        });

        it('returns null when the clipboard holds no image', async () => {
            clipboardFlavors = ['text/plain'];
            const { readClipboardImageToTemp } = await loadModule();
            expect(await readClipboardImageToTemp()).toBeNull();
        });

        it('returns null for an empty image payload', async () => {
            clipboardFlavors = ['image/png'];
            clipboardImageBytes = [];
            const { readClipboardImageToTemp } = await loadModule();
            expect(await readClipboardImageToTemp()).toBeNull();
        });
    });

    describe('removeTempFile', () => {
        it('removes the scratch folder created for the copy', async () => {
            const { writePastedFileToTemp, removeTempFile } = await loadModule();
            const path = await writePastedFileToTemp(fakeFile('paper.pdf', 'application/pdf'));
            await removeTempFile(path!);
            expect(IOUtils.remove).toHaveBeenCalledWith(
                PathUtils.parent(path!),
                { ignoreAbsent: true, recursive: true },
            );
        });

        it('removes only the file when it is not in a scratch folder', async () => {
            const { removeTempFile } = await loadModule();
            await removeTempFile('/Users/me/Documents/paper.pdf');
            expect(IOUtils.remove).toHaveBeenCalledWith(
                '/Users/me/Documents/paper.pdf',
                { ignoreAbsent: true, recursive: true },
            );
        });

        it('never throws when removal fails', async () => {
            vi.mocked(IOUtils.remove).mockRejectedValueOnce(new Error('locked'));
            const { removeTempFile } = await loadModule();
            await expect(removeTempFile('/tmp/zotero/beaver-paste-1/x.png')).resolves.toBeUndefined();
        });
    });
});
