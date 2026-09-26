/**
 * Extend the transaction owned by Zotero's native merge. Zotero's merge entry
 * calls executeTransaction synchronously. Restore that entry before invoking
 * the original transaction method, so no replacement survives an async yield
 * and unrelated transactions retain their normal behavior.
 */
export async function nativeMergeTransaction<T>(
    master: Zotero.Item,
    others: Zotero.Item[],
    operation: (merge: () => Promise<unknown>) => Promise<T>,
): Promise<T> {
    const db = Zotero.DB;
    const execute = db.executeTransaction;
    let entered = false;
    let result!: T;
    const intercept = function (
        callback: (...args: any[]) => any,
        options?: Parameters<typeof execute>[1],
    ) {
        db.executeTransaction = execute;
        entered = true;
        return execute.call(
            db,
            async (...args: any[]) => {
                result = await operation(() => (callback as any)(...args));
                return result;
            },
            options,
        );
    } as typeof execute;
    // Installed only when the native merge has been started but did not enter
    // its transaction synchronously. Denying the late transaction turns a
    // future Zotero that merges outside this wrapper — unreviewed, with no
    // undo record, and irreversible — into a clean failure that writes
    // nothing. It is never installed against today's synchronous merge.
    const deny = function () {
        return Promise.reject(
            new Error(
                "The native Zotero merge did not enter its transaction synchronously.",
            ),
        );
    } as typeof execute;
    let pending: Promise<unknown> | undefined;
    db.executeTransaction = intercept;
    try {
        pending = Zotero.Items.merge(master, others);
    } finally {
        if (db.executeTransaction === intercept)
            db.executeTransaction = pending ? deny : execute;
    }
    try {
        await pending;
    } catch (error: any) {
        // Zotero distinguishes a failure after commit from a rolled-back write.
        // The undo result was already constructed inside the transaction.
        if (error?.committed && entered && result) return result;
        throw error;
    } finally {
        if (db.executeTransaction === deny) db.executeTransaction = execute;
    }
    if (!entered)
        throw new Error(
            "The native Zotero merge did not enter its transaction synchronously.",
        );
    return result;
}
