import React from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import {
    aggregatedErrorMessagesForSkippedFilesAtom,
    errorCodeStatsErrorAtom,
    errorCodeStatsIsLoadingAtom,
    errorMappingOverview,
    errorMappingHintAtom
} from '../../atoms/files';
import { useErrorCodeStats } from '../../hooks/useErrorCodeStats';
import { Spinner } from '../icons/icons';
import Button from '../ui/Button';
import { isSkippedFilesDialogVisibleAtom } from '../../atoms/ui';

/**
 * Convert plural "Files" to singular "File" when count is 1
 * @param text The text containing "Files"
 * @param count The number of files
 * @returns Text with appropriate singular/plural form
 */
const makeSingularIfNeeded = (text: string, count: number): string => {
    if (count === 1) {
        return text.replace(/^Files exceed\b/, 'File exceeds').replace(/^Files\b/, 'File');
    }
    return text;
};

export const SkippedFilesSummary: React.FC = () => {
    const { fetchStats } = useErrorCodeStats();
    const isLoading = useAtomValue(errorCodeStatsIsLoadingAtom);
    const error = useAtomValue(errorCodeStatsErrorAtom);
    const aggregatedMessages = useAtomValue(
        aggregatedErrorMessagesForSkippedFilesAtom
    );
    const errorHint = useAtomValue(errorMappingHintAtom);
    const setIsDialogVisible = useSetAtom(isSkippedFilesDialogVisibleAtom);

    React.useEffect(() => {
        fetchStats();
    }, [fetchStats]);

    const handleShowFiles = () => {
        setIsDialogVisible(true);
    };

    const hasData = Object.keys(aggregatedMessages).length > 0;

    if (isLoading && !hasData) {
        return (
            <div className="text-base font-color-secondary mb-1 items-center display-flex flex-row">
                <div className="mt-1">
                    <Spinner size={14} />
                </div>
                <div className="ml-2 font-color-tertiary">Loading...</div>
            </div>
        );
    }

    if (error) {
        return (
            <div className="text-base font-color-secondary mb-1">
                {typeof error === 'object' && error !== null && 'message' in error
                    ? String((error as { message: unknown }).message)
                    : String(error)}
            </div>
        );
    }

    if (!hasData) {
        return null;
    }

    // Sort entries by count (highest first)
    const sortedEntries = Object.entries(aggregatedMessages).sort(
        ([, a], [, b]) => b.count - a.count
    );

    return (
        <div className="display-flex flex-col gap-3 w-full ml-1">
            <div className="display-flex flex-col border-left-quarternary px-2 gap-4">
                {sortedEntries.map(
                    ([errorCode, { message, count }]) => (
                        <div key={errorCode} className="display-flex flex-col gap-0">
                            <span className="font-color-secondary mr-4">
                                {String(count).toLocaleString()} {makeSingularIfNeeded(
                                    String(errorMappingOverview[errorCode as keyof typeof errorMappingOverview]),
                                    count
                                )}
                            </span>
                            {errorHint[errorCode as keyof typeof errorHint] && (
                                <span className="font-color-tertiary mr-4">
                                    {errorHint[errorCode as keyof typeof errorHint]}
                                </span>
                            )}
                        </div>
                    )
                )}
            </div>
            <div className="display-flex justify-between items-center ml-2">
                <Button
                    variant="outline"
                    onClick={handleShowFiles}
                >
                    Show Files
                </Button>
                {isLoading && (
                    <div className="mr-2 display-flex items-center gap-1 font-color-tertiary">
                        <div><Spinner className="mt-020" size={14} /></div>
                        <div>Updating...</div>
                    </div>
                )}
            </div>
        </div>
    );
};
