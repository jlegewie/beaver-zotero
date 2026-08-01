import { useMemo } from 'react';
import type { ComposerPasteHandlers } from '../components/input/lexical/LexicalEditorInput';
import { useAttachExternalFiles } from './useAttachExternalFiles';
import {
    clipboardHasFile,
    clipboardHasImage,
    readClipboardFilePath,
    readClipboardImageToTemp,
    removeTempFile,
    writePastedFileToTemp,
} from '../../src/services/clipboardFiles';
import { logger } from '../../src/utils/logger';

/**
 * Wires the composer's paste handling to the external-file attach path, so a
 * figure copied out of a PDF, a screenshot, or a file copied in a file manager
 * becomes a message attachment.
 *
 * Files that arrive as clipboard bytes have no path on disk, so they are
 * spilled to a temp copy first; the attach copies them into the Beaver-managed
 * folder, after which the temp copy is discarded. Unsupported types, oversized
 * files, and images without a vision-capable model are reported by the shared
 * attach hook as popups.
 */
export function useComposerPasteHandlers(): ComposerPasteHandlers {
    const attachExternalFiles = useAttachExternalFiles();

    return useMemo<ComposerPasteHandlers>(() => {
        const attachTempPaths = async (paths: string[]) => {
            try {
                await attachExternalFiles(paths);
            } finally {
                await Promise.all(paths.map((path) => removeTempFile(path)));
            }
        };

        const onPasteFiles = (files: File[]) => {
            (async () => {
                const written = await Promise.all(files.map((file) => writePastedFileToTemp(file)));
                const paths = written.filter((path): path is string => path !== null);
                if (paths.length === 0) return;
                await attachTempPaths(paths);
            })().catch((error) => {
                logger(`useComposerPasteHandlers.onPasteFiles: ${error}`, 1);
            });
        };

        const onPasteFromClipboard = () => {
            (async () => {
                // A file copied in a file manager already lives on disk, so it
                // is attached from its own path and keeps its real name.
                const path = readClipboardFilePath();
                if (path) {
                    await attachExternalFiles([path]);
                    return;
                }
                // Otherwise the clipboard holds raw image bytes, which have to
                // be spilled to disk before they can be attached.
                const tempPath = await readClipboardImageToTemp();
                if (tempPath) await attachTempPaths([tempPath]);
            })().catch((error) => {
                logger(`useComposerPasteHandlers.onPasteFromClipboard: ${error}`, 1);
            });
        };

        return {
            onPasteFiles,
            hasClipboardFile: clipboardHasFile,
            hasClipboardImage: clipboardHasImage,
            onPasteFromClipboard,
        };
    }, [attachExternalFiles]);
}
