/**
 * Log a message to the Zotero debug console and, in development, to the browser console.
 * 
 * Backward compatible signature: logger(message, level?, maxDepth?, stack?)
 * New signature: logger(message, data, level?, maxDepth?, stack?)
 * 
 * @param message The message to log
 * @param arg2 Data object to log OR the debug level (number)
 * @param arg3 Debug level (if data provided) OR maxDepth
 * @param arg4 maxDepth (if data provided) OR stack
 * @param arg5 stack (if data provided)
 */
export const logger = function (
    message: string,
    arg2?: any,
    arg3?: any,
    arg4?: any,
    arg5?: any,
) {
    const safeStringify = (value: any) => {
        try {
            return JSON.stringify(value);
        } catch (error) {
            return '[Unserializable data]';
        }
    };

    let data: any = null;
    let level: number | undefined;
    let maxDepth: number | undefined;
    let stack: number | boolean | undefined;

    // Detect signature based on type of second argument
    if (typeof arg2 === 'number') {
        // Old signature: logger(message, level, maxDepth, stack)
        level = arg2;
        maxDepth = arg3;
        stack = arg4;
    } else {
        // New signature: logger(message, data, level, maxDepth, stack)
        data = arg2;
        level = arg3;
        maxDepth = arg4;
        stack = arg5;
    }

    const prefix = `[Beaver] ${message}`;
    
    // Log to browser console in development for object inspection
    if ("Beaver" in Zotero && (Zotero as any).Beaver.data.env === "development") {
        if (data !== null && data !== undefined) {
            console.log(prefix, data);
        } else {
            console.log(prefix);
        }
    }

    // Log to Zotero debug console (text-only)
    // Use JSON.stringify for data to make it visible in the Zotero debug output
    const debugMsg = (data !== null && data !== undefined) ? `${prefix} ${safeStringify(data)}` : prefix;
    Zotero.debug(debugMsg, level, maxDepth, stack);
}
