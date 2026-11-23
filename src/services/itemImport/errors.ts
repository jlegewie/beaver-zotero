/** A write failure with a stable code; `details` carries e.g. the existing item. */
export class ImportItemError extends Error {
    constructor(public readonly code: string, message: string, public readonly details?: Record<string, unknown>) {
        super(message);
        this.name = 'ImportItemError';
    }
}
