/** Table chat is restricted to development builds until release opt-in. */
export function isTableChatEnabled(): boolean {
    return Zotero.Beaver?.data?.env === "development";
}
