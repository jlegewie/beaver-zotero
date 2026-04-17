/**
 * Seeds a minimal subset of Zotero's SQLite schema into a MockDBConnection.
 *
 * The goal is just enough to exercise `batchFindExistingReferences` end-to-end
 * against real SQL: items + itemData + itemDataValues + deletedItems +
 * creators + itemCreators. Column types mirror Zotero's schema closely enough
 * for our SQL to run, but we skip all the bookkeeping constraints Zotero
 * enforces at runtime.
 */

import { MockDBConnection } from '../mocks/mockDBConnection';

export interface SeededItem {
    itemID?: number;
    libraryID?: number;
    key?: string;
    itemType?: string;       // 'journalArticle', 'book', 'note', 'attachment', etc.
    title?: string;          // stored in 'title' field by default
    titleFieldName?: 'title' | 'publicationTitle' | 'bookTitle';  // for testing mapped fields
    doi?: string;
    isbn?: string;
    date?: string;
    creators?: string[];     // last names in order
    deleted?: boolean;
}

interface SeedContext {
    nextItemID: number;
    nextCreatorID: number;
    nextValueID: number;
}

/**
 * Create Zotero tables in the given MockDBConnection. Safe to call multiple
 * times per test (CREATE IF NOT EXISTS).
 */
export async function createZoteroSchema(conn: MockDBConnection): Promise<void> {
    // items(itemID INTEGER PK, itemTypeID, libraryID, key)
    await conn.queryAsync(`
        CREATE TABLE IF NOT EXISTS items (
            itemID INTEGER PRIMARY KEY,
            itemTypeID INTEGER NOT NULL,
            libraryID INTEGER NOT NULL,
            key TEXT NOT NULL
        )
    `);

    // itemDataValues(valueID INTEGER PK, value UNIQUE)
    await conn.queryAsync(`
        CREATE TABLE IF NOT EXISTS itemDataValues (
            valueID INTEGER PRIMARY KEY,
            value TEXT UNIQUE
        )
    `);

    // itemData(itemID, fieldID, valueID)
    await conn.queryAsync(`
        CREATE TABLE IF NOT EXISTS itemData (
            itemID INTEGER NOT NULL,
            fieldID INTEGER NOT NULL,
            valueID INTEGER NOT NULL,
            PRIMARY KEY (itemID, fieldID)
        )
    `);

    // deletedItems(itemID PK)
    await conn.queryAsync(`
        CREATE TABLE IF NOT EXISTS deletedItems (
            itemID INTEGER PRIMARY KEY
        )
    `);

    // creators(creatorID INTEGER PK, firstName, lastName)
    await conn.queryAsync(`
        CREATE TABLE IF NOT EXISTS creators (
            creatorID INTEGER PRIMARY KEY,
            firstName TEXT,
            lastName TEXT
        )
    `);

    // itemCreators(itemID, creatorID, orderIndex)
    await conn.queryAsync(`
        CREATE TABLE IF NOT EXISTS itemCreators (
            itemID INTEGER NOT NULL,
            creatorID INTEGER NOT NULL,
            orderIndex INTEGER NOT NULL,
            PRIMARY KEY (itemID, orderIndex)
        )
    `);
}

/** Reset a SeedContext for a fresh run. */
export function createSeedContext(): SeedContext {
    return { nextItemID: 1, nextCreatorID: 1, nextValueID: 1 };
}

/** Insert (or reuse) a value row in itemDataValues and return its valueID. */
async function insertValue(conn: MockDBConnection, ctx: SeedContext, value: string): Promise<number> {
    // Check if a value already exists
    const existing = await conn.queryAsync(
        `SELECT valueID FROM itemDataValues WHERE value = ?`,
        [value]
    );
    if (existing.length > 0) {
        return (existing[0] as any).valueID;
    }
    const id = ctx.nextValueID++;
    await conn.queryAsync(
        `INSERT INTO itemDataValues (valueID, value) VALUES (?, ?)`,
        [id, value]
    );
    return id;
}

/**
 * Seed a single item with its fields and creators. Returns the itemID.
 */
export async function seedZoteroItem(
    conn: MockDBConnection,
    ctx: SeedContext,
    item: SeededItem
): Promise<number> {
    const fieldIDs = (globalThis as any).__TEST_FIELD_IDS as Record<string, number>;
    const typeIDs = (globalThis as any).__TEST_TYPE_IDS as Record<string, number>;
    if (!fieldIDs || !typeIDs) {
        throw new Error('Test setup missing: __TEST_FIELD_IDS / __TEST_TYPE_IDS (see tests/setup.ts)');
    }

    const itemID = item.itemID ?? ctx.nextItemID++;
    if (item.itemID != null && item.itemID >= ctx.nextItemID) {
        ctx.nextItemID = item.itemID + 1;
    }

    const itemTypeName = item.itemType ?? 'journalArticle';
    const itemTypeID = typeIDs[itemTypeName];
    if (itemTypeID == null) throw new Error(`Unknown itemType in test: ${itemTypeName}`);

    const libraryID = item.libraryID ?? 1;
    const key = item.key ?? `K${itemID.toString().padStart(7, '0')}`;

    await conn.queryAsync(
        `INSERT INTO items (itemID, itemTypeID, libraryID, key) VALUES (?, ?, ?, ?)`,
        [itemID, itemTypeID, libraryID, key]
    );

    const addField = async (fieldName: string, value: string | undefined) => {
        if (value == null || value === '') return;
        const fieldID = fieldIDs[fieldName];
        if (!fieldID) throw new Error(`Unknown field in test: ${fieldName}`);
        const valueID = await insertValue(conn, ctx, value);
        await conn.queryAsync(
            `INSERT INTO itemData (itemID, fieldID, valueID) VALUES (?, ?, ?)`,
            [itemID, fieldID, valueID]
        );
    };

    if (item.title) {
        await addField(item.titleFieldName ?? 'title', item.title);
    }
    await addField('DOI', item.doi);
    await addField('ISBN', item.isbn);
    await addField('date', item.date);

    if (item.deleted) {
        await conn.queryAsync(`INSERT INTO deletedItems (itemID) VALUES (?)`, [itemID]);
    }

    if (item.creators) {
        for (let i = 0; i < item.creators.length; i++) {
            const lastName = item.creators[i];
            const creatorID = ctx.nextCreatorID++;
            await conn.queryAsync(
                `INSERT INTO creators (creatorID, firstName, lastName) VALUES (?, ?, ?)`,
                [creatorID, '', lastName]
            );
            await conn.queryAsync(
                `INSERT INTO itemCreators (itemID, creatorID, orderIndex) VALUES (?, ?, ?)`,
                [itemID, creatorID, i]
            );
        }
    }

    return itemID;
}

/**
 * Install the MockDBConnection as Zotero.DB so the code-under-test can call
 * `Zotero.DB.queryAsync` against it.
 */
export function installZoteroDB(conn: MockDBConnection): void {
    (globalThis as any).Zotero.DB = {
        queryAsync: conn.queryAsync.bind(conn),
        executeTransaction: conn.executeTransaction.bind(conn),
    };
}
