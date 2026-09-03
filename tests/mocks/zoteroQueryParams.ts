/**
 * Port of Zotero.DBConnection.prototype.parseQueryAndParams
 * (zotero/chrome/content/zotero/xpcom/db.js).
 *
 * Zotero does not bind NULL parameters. It splices a literal NULL into the SQL
 * text instead, locating the placeholder to replace by scanning for
 * `/\s*[=,(]\s*\?/g` and advancing that scan once per parameter. A placeholder
 * that does not follow `=`, `,` or `(` — `IS ?`, `IS NOT ?`, `CASE WHEN ?` — is
 * invisible to the scan, so a single NULL parameter desynchronizes it and the
 * splice lands on an unrelated placeholder (or runs out and throws).
 *
 * MockDBConnection runs queries through this first so unit tests see the
 * statement Zotero would actually execute, not the one better-sqlite3 would
 * happily bind.
 */
export function parseQueryAndParams(sql: string, params: any): [string, any[]] {
    // If single scalar value, wrap in an array
    if (!Array.isArray(params)) {
        if (
            typeof params == 'string' ||
            typeof params == 'number' ||
            typeof params == 'object' ||
            params === null
        ) {
            params = [params];
        } else {
            params = [];
        }
    }
    // Otherwise, since we might make changes, only work on a copy of the array
    else {
        params = params.concat();
    }

    // Find placeholders
    if (params.length) {
        let matches = sql.match(/\?\d*/g);
        if (!matches) {
            throw new Error(
                'Parameters provided for query without placeholders [QUERY: ' + sql + ']',
            );
        } else {
            // Count numbered parameters (?1) properly
            let num = 0;
            const numbered: Record<string, boolean> = {};
            for (let i = 0; i < matches.length; i++) {
                const match = matches[i];
                if (match == '?') {
                    num++;
                } else {
                    numbered[match] = true;
                }
            }
            num += Object.keys(numbered).length;

            if (params.length != num) {
                throw new Error(
                    'Incorrect number of parameters provided for query (' +
                        params.length +
                        ', expecting ' +
                        num +
                        ') [QUERY: ' +
                        sql +
                        ']',
                );
            }
        }

        // First, determine the type of query using first word
        const queryMethod = sql.match(/^[^\s(]*/)![0].toLowerCase();

        // Reset lastIndex, since regexp isn't recompiled dynamically
        const placeholderRE = /\s*[=,(]\s*\?/g;
        for (let i = 0; i < params.length; i++) {
            // Find index of this parameter, skipping previous ones
            matches = placeholderRE.exec(sql) as any;

            if (typeof params[i] == 'boolean') {
                throw new Error(
                    'Invalid boolean parameter ' +
                        i +
                        " '" +
                        params[i] +
                        "' [QUERY: " +
                        sql +
                        ']',
                );
            } else if (params[i] === undefined) {
                throw new Error('Parameter ' + i + ' is undefined [QUERY: ' + sql + ']');
            }

            if (params[i] !== null) {
                // Force parameter type if specified
                if (typeof params[i]['int'] != 'undefined') {
                    params[i] = parseInt(params[i]['int']);
                    if (isNaN(params[i])) {
                        throw new Error(
                            'Invalid bound parameter ' +
                                i +
                                " integer value '" +
                                params[i] +
                                "' [QUERY: " +
                                sql +
                                ']',
                        );
                    }
                } else if (typeof params[i]['string'] != 'undefined') {
                    params[i] = params[i]['string'] + '';
                }

                continue;
            }

            //
            // Replace NULL bound parameters with hard-coded NULLs
            //
            if (!matches) {
                throw new Error(
                    'Null parameter provided for a query without placeholders ' +
                        '-- use false or undefined [QUERY: ' +
                        sql +
                        ']',
                );
            }

            let repl: string;
            if (matches[0].trim().indexOf('=') == -1) {
                if (queryMethod == 'select') {
                    throw new Error(
                        'NULL cannot be used for parenthesized placeholders ' +
                            'in SELECT queries [QUERY: ' +
                            sql +
                            ']',
                    );
                }
                repl = matches[0].replace('?', 'NULL');
            } else if (queryMethod == 'select') {
                repl = ' IS NULL';
            } else {
                repl = '=NULL';
            }

            const subpos = (matches as any).index;
            const sublen = matches[0].length;
            sql = sql.substring(0, subpos) + repl + sql.substr(subpos + sublen);

            params.splice(i, 1);
            i--;
        }
        if (!params.length) {
            params = [];
        }
    } else if (/\?/g.test(sql)) {
        throw new Error(
            'Parameters not provided for query containing placeholders [QUERY: ' + sql + ']',
        );
    }

    return [sql, params];
}
