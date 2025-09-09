import React from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import {
    aggregatedErrorMessagesForSkippedFilesAtom,
    errorCodeStatsErrorAtom,
    errorCodeStatsIsLoadingAtom,
    errorMappingOverview
} from '../../atoms/files';
import { useErrorCodeStats } from '../../hooks/useErrorCodeStats';
import { Spinner } from '../icons/icons';
import Button from '../ui/Button';
import { isSkippedFilesDialogVisibleAtom } from '../../atoms/ui';



export const SkippedFilesSummary: React.FC = () => {
    const { fetchStats } = useErrorCodeStats();
    const isLoading = useAtomValue(errorCodeStatsIsLoadingAtom);
    const error = useAtomValue(errorCodeStatsErrorAtom);
    const aggregatedMessages = useAtomValue(
        aggregatedErrorMessagesForSkippedFilesAtom
    );
    const setIsDialogVisible = useSetAtom(isSkippedFilesDialogVisibleAtom);

    React.useEffect(() => {
        fetchStats();
    }, [fetchStats]);

    const handleShowFiles = () => {
        setIsDialogVisible(true);
    };

    if (isLoading) {
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

    if (Object.keys(aggregatedMessages).length === 0) {
        return null;
    }
    console.log(aggregatedMessages);

    return (
        <div className="display-flex flex-col gap-2 w-full">
            <ul className="marker-secondary" style={{ paddingInlineStart: '15px', marginBlockStart: '0px', marginBlockEnd: '0px' }}>
                {Object.entries(aggregatedMessages).map(
                    ([errorCode, { message, count }]) => (
                        <li key={errorCode}>
                            <span className="font-color-secondary mr-4">
                                {String(count).toLocaleString()} {String(errorMappingOverview[errorCode as keyof typeof errorMappingOverview])}
                            </span>
                            {/* <span className="font-color-tertiary mr-4">
                                The current beta version does not support files without a text layer.
                            </span> */}
                        </li>
                    )
                )}
            </ul>
            <div className="display-flex justify-start mt-2">
                <Button
                    variant="outline"
                    onClick={handleShowFiles}
                >
                    Show Files
                </Button>
            </div>
        </div>
    );
};
