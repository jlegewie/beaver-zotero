import type { VoiceOptions } from "@beaver/agent-core/voice/contracts";
import type { ZoteroContext } from "../atoms/zoteroContext";

const commonTitleWords = new Set(
    "about after again against among analysis based before being between could during effects from have into more most other over research study studies that their them these they this through under using were what when where which while with would".split(
        " ",
    ),
);

/** Stable priority order; provider hints stay short while correction can retain full names. */
export function selectVoiceTerms(
    groups: readonly (readonly string[])[],
    maxTerms: number,
    maxCharacters: number,
    maxTermLength: number,
): string[] {
    const result: string[] = [],
        seen = new Set<string>();
    let length = 0;
    for (const group of groups)
        for (const raw of group) {
            const term = raw.normalize("NFC").replace(/\s+/g, " ").trim();
            if (
                !term ||
                term.includes("\0") ||
                /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
                    term,
                ) ||
                term.length > maxTermLength ||
                seen.has(term.toLocaleLowerCase())
            )
                continue;
            if (
                result.length >= maxTerms ||
                length + term.length > maxCharacters
            )
                continue;
            seen.add(term.toLocaleLowerCase());
            result.push(term);
            length += term.length;
        }
    return result;
}
export interface VoiceSourceSnapshot {
    options: VoiceOptions;
    libraryIds: readonly number[];
    itemIds: readonly number[];
    collectionIds: readonly number[];
}

/** Enumerate only activation-time context, never old composer attachments or excluded metadata. */
export async function collectVoiceVocabulary(
    context: ZoteroContext,
    language: string,
    eligible: (id: number) => boolean,
): Promise<VoiceSourceSnapshot> {
    const collections = (
        context.isLibraryTab ? context.libraryView.selectedCollections : []
    ).filter((c) => eligible(c.libraryId));
    const items = (
        context.isLibraryTab
            ? [...context.selectedItems]
            : context.readerAttachment
              ? [context.readerAttachment]
              : []
    )
        .filter((item) => eligible(item.libraryID))
        .slice(0, 100);
    const collectionIds = new Set(collections.map((c) => c.collectionId));
    const libraryIds = new Set(collections.map((c) => c.libraryId));
    const itemIds: number[] = [],
        authors: string[] = [],
        titles: string[] = [],
        journals: string[] = [];
    const tags = new Map<string, number>();
    for (let item of items) {
        if (!eligible(item.libraryID)) continue;
        if (item.parentID) item = await Zotero.Items.getAsync(item.parentID);
        if (!item || !eligible(item.libraryID)) continue;
        libraryIds.add(item.libraryID);
        itemIds.push(item.id);
        await item.loadDataType("itemData");
        await item.loadDataType("creators");
        await item.loadDataType("tags");
        await item.loadDataType("collections");
        if (!eligible(item.libraryID))
            throw new Error("Source eligibility changed");
        for (const collectionId of item.getCollections().slice(0, 20)) {
            if (collections.length >= 100 || collectionIds.has(collectionId))
                continue;
            if (!eligible(item.libraryID))
                throw new Error("Source eligibility changed");
            const collection = await Zotero.Collections.getAsync(collectionId);
            if (!collection || !eligible(collection.libraryID))
                throw new Error("Source eligibility changed");
            collections.push({
                collectionId,
                collectionName: collection.name,
                libraryId: collection.libraryID,
            });
            collectionIds.add(collectionId);
            libraryIds.add(collection.libraryID);
        }
        authors.push(
            ...item
                .getCreators()
                .slice(0, 50)
                .map((c) => c.lastName),
        );
        titles.push(
            ...String(item.getField("title"))
                .slice(0, 2000)
                .split(/[^\p{L}\p{N}'’-]+/u)
                .filter(
                    (t) =>
                        t.length >= 4 && !commonTitleWords.has(t.toLowerCase()),
                ),
        );
        journals.push(String(item.getField("publicationTitle")).slice(0, 1000));
        for (const tag of item.getTags().slice(0, 100))
            tags.set(tag.tag, (tags.get(tag.tag) ?? 0) + 1);
    }
    const names = collections.map((c) => c.collectionName);
    const rankedTags = [...tags]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([tag]) => tag);
    const groups = [
        names,
        authors,
        context.isLibraryTab ? [] : titles,
        rankedTags,
    ];
    if ([...libraryIds].some((id) => !eligible(id)))
        throw new Error("Source eligibility changed");
    return {
        options: {
            language,
            biasTerms: selectVoiceTerms(groups, 50, 2000, 80),
            correctionVocabulary: selectVoiceTerms(
                [...groups, titles, journals],
                1000,
                32000,
                300,
            ),
        },
        libraryIds: [...libraryIds],
        itemIds,
        collectionIds: collections.map((c) => c.collectionId),
    };
}
