/**
 * File I/O for shareable actions.
 *
 * Thin Zotero-aware layer over the pure schema in `../types/actionShare`:
 * native save/open file pickers, reading and writing `.beaveraction` files.
 * The (de)serialization and validation live in the schema module; this file
 * only touches the filesystem and the picker.
 */

import type { Action } from '../types/actions';
import {
    serializeAction,
    parseShareableAction,
    SHAREABLE_ACTION_FILE_EXTENSION,
    type ParseShareableActionResult,
} from '../types/actionShare';
import { getActionCommand } from './slashCommands';
import { logger } from '../../src/utils/logger';

const DOT_EXT = `.${SHAREABLE_ACTION_FILE_EXTENSION}`;

/** Default file name offered by the save dialog: `<command>.beaveraction`. */
const suggestedFileName = (action: Action): string =>
    `${getActionCommand(action) || 'action'}${DOT_EXT}`;

/** True when a path looks like an exported action file. */
export const isActionFilePath = (path: string): boolean =>
    path.toLowerCase().endsWith(DOT_EXT);

interface ZoteroFilePicker {
    init(parent: Window, title: string, mode: number): void;
    appendFilter(title: string, filter: string): void;
    appendFilters(mask: number): void;
    show(): Promise<number>;
    file: string;
    defaultString: string;
    modeOpen: number;
    modeSave: number;
    returnOK: number;
    returnCancel: number;
    returnReplace: number;
    filterAll: number;
}

const createFilePicker = (): ZoteroFilePicker => {
    const { FilePicker } = ChromeUtils.importESModule(
        'chrome://zotero/content/modules/filePicker.mjs',
    ) as { FilePicker: new () => ZoteroFilePicker };
    return new FilePicker();
};

/**
 * Prompt for a location and write `action` there as a `.beaveraction` file.
 * Returns the written path, or null if the user cancelled.
 */
export const exportActionToFile = async (action: Action): Promise<string | null> => {
    const fp = createFilePicker();
    fp.init(Zotero.getMainWindow(), 'Save Action', fp.modeSave);
    fp.appendFilter('Beaver action', `*${DOT_EXT}`);
    fp.appendFilters(fp.filterAll);
    fp.defaultString = suggestedFileName(action);

    const rv = await fp.show();
    if (rv !== fp.returnOK && rv !== fp.returnReplace) return null;

    // Some platforms drop the extension if the user removes it; enforce it so
    // the file round-trips through the import picker's filter.
    let path = fp.file;
    if (!isActionFilePath(path)) path += DOT_EXT;

    await IOUtils.writeUTF8(path, serializeAction(action));
    return path;
};

/**
 * Prompt for a `.beaveraction` file and parse it. Returns null if the user
 * cancelled; otherwise a parse result (which may itself be an error).
 */
export const importActionFromFile = async (): Promise<ParseShareableActionResult | null> => {
    const fp = createFilePicker();
    fp.init(Zotero.getMainWindow(), 'Import Action', fp.modeOpen);
    fp.appendFilter('Beaver action', `*${DOT_EXT}`);
    fp.appendFilters(fp.filterAll);

    const rv = await fp.show();
    if (rv !== fp.returnOK) return null;

    return readActionFile(fp.file);
};

/** Read and parse an action file at a known path (e.g. drag & drop). */
export const readActionFile = async (path: string): Promise<ParseShareableActionResult> => {
    try {
        const contents = await IOUtils.readUTF8(path);
        return parseShareableAction(contents);
    } catch (e) {
        logger(`actionShareFile.readActionFile: ${e}`, 1);
        return { ok: false, error: 'Could not read the action file.' };
    }
};
