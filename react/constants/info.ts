
export interface InfoItem {
    title: string;
    description?: string;
    url?: string;
    tooltip?: string;
}

export const infoItemList: InfoItem[] = [
    {
        title: "File not synced with Beaver",
        url: "https://github.com/jlegewie/beaver-zotero/wiki/Error-File-not-synced-with-Beaver",
        tooltip: "Get help with this error",
    }
];

export const getInfoItemByTitle = (title: string): InfoItem | undefined => {
    return infoItemList.find((item) => item.title === title);
};