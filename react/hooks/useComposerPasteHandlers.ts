import { useMemo } from 'react';
import { useSetAtom } from 'jotai';
import type { ComposerPasteHandlers } from '../components/input/lexical/LexicalEditorInput';
import { useAttachExternalFiles, useHoldSendForAttachment } from './useAttachExternalFiles';
import { addPopupMessageAtom } from '../utils/popupMessageUtils';
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
 * becomes a message attachment. Content that arrives as clipboard bytes has no
 * path, so it is spilled to a temp copy first and discarded once attached.
 */
export function useComposerPasteHandlers(): ComposerPasteHandlers {
    const attachExternalFiles = useAttachExternalFiles();
    const holdSendForAttachment = useHoldSendForAttachment();
    const addPopupMessage = useSetAtom(addPopupMessageAtom);

    return useMemo<ComposerPasteHandlers>(() => {
        const reportFailure = () => addPopupMessage({
            type: 'warning',
            title: 'File not added',
            text: 'The pasted content could not be read.',
            expire: true,
        });

        const attachTempPaths = async (paths: string[]) => {
            try {
                await attachExternalFiles(paths);
            } finally {
                await Promise.all(paths.map((path) => removeTempFile(path)));
            }
        };

        // Runs inside the hold so sending stays blocked for the whole paste,
        // including the copy to disk that precedes the attach.
        const runPaste = (label: string, work: () => Promise<void>) => {
            holdSendForAttachment(work).catch((error) => {
                logger(`useComposerPasteHandlers.${label}: ${error}`, 1);
                reportFailure();
            });
        };

        const onPasteFiles = (files: File[]) => runPaste('onPasteFiles', async () => {
            const written = await Promise.all(files.map((file) => writePastedFileToTemp(file)));
            const paths = written.filter((path): path is string => path !== null);
            // Reported rather than dropped, so a paste never looks ignored.
            if (paths.length < files.length) reportFailure();
            if (paths.length === 0) return;
            await attachTempPaths(paths);
        });

        const onPasteFromClipboard = () => runPaste('onPasteFromClipboard', async () => {
            // A file copied in a file manager already lives on disk, so it is
            // attached from its own path and keeps its real name.
            const path = readClipboardFilePath();
            if (path) {
                await attachExternalFiles([path]);
                return;
            }
            const tempPath = await readClipboardImageToTemp();
            if (!tempPath) {
                reportFailure();
                return;
            }
            await attachTempPaths([tempPath]);
        });

        return {
            onPasteFiles,
            hasClipboardFile: clipboardHasFile,
            hasClipboardImage: clipboardHasImage,
            onPasteFromClipboard,
        };
    }, [attachExternalFiles, holdSendForAttachment, addPopupMessage]);
}
