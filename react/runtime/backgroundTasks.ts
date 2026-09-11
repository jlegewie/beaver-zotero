import type { BackgroundTaskSource } from '../../src/utils/backgroundTasks';

/** Read the plugin-owned registry instead of creating a renderer-local task registry. */
export const subscribeToTasks: BackgroundTaskSource['subscribeToTasks'] = listener =>
    Zotero.Beaver.backgroundTasks.subscribeToTasks(listener);
export const getTasksForItem: BackgroundTaskSource['getTasksForItem'] = (...args) =>
    Zotero.Beaver.backgroundTasks.getTasksForItem(...args);
export const getTasksByType: BackgroundTaskSource['getTasksByType'] = type =>
    Zotero.Beaver.backgroundTasks.getTasksByType(type);
export const getActiveTasks: BackgroundTaskSource['getActiveTasks'] = () =>
    Zotero.Beaver.backgroundTasks.getActiveTasks();
export const getAllTasks: BackgroundTaskSource['getAllTasks'] = () =>
    Zotero.Beaver.backgroundTasks.getAllTasks();
