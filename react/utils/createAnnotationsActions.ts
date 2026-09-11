import * as operations from '../../src/services/manualActions/createAnnotationsActions';
import { runWindowOperation } from '../runtime/libraryMutation';

export function undoCreateAnnotationsAction(...args: Parameters<typeof operations.undoCreateAnnotationsAction>): ReturnType<typeof operations.undoCreateAnnotationsAction> {
    return runWindowOperation('undoCreateAnnotationsAction', args);
}

export function executeCreateHighlightAnnotationsAction(...args: Parameters<typeof operations.executeCreateHighlightAnnotationsAction>): ReturnType<typeof operations.executeCreateHighlightAnnotationsAction> {
    return runWindowOperation('executeCreateHighlightAnnotationsAction', args);
}

export function executeCreateNoteAnnotationsAction(...args: Parameters<typeof operations.executeCreateNoteAnnotationsAction>): ReturnType<typeof operations.executeCreateNoteAnnotationsAction> {
    return runWindowOperation('executeCreateNoteAnnotationsAction', args);
}
