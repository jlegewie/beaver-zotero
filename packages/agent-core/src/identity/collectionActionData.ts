import { resolveObjectIdReference } from './libraryRef';

/** Portable fields take precedence, including an explicit null parent. */
export function readCollectionActionData(data: Record<string, any>): Record<string, any> {
    const result = { ...data };
    for (const [portable, native] of [
        ['collection_id', 'collection_key'],
        ['parent_collection_id', 'parent_key'],
        ['new_parent_collection_id', 'new_parent_key'],
        ['old_parent_collection_id', 'old_parent_key'],
    ]) {
        if (data[portable] !== undefined && (native !== 'collection_key' || data[portable] != null)) result[native] = data[portable];
    }
    const target = resolveObjectIdReference(typeof data.collection_id === 'string' ? data.collection_id : data.collection_key ?? '');
    if (target && !data.library_ref && !data.library_id) {
        result.library_ref = target.library_ref;
        result.library_id = target.library_id;
    }
    return result;
}
