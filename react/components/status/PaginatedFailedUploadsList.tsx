import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useAtomValue } from 'jotai';
import { userIdAtom } from '../../atoms/auth';
import { attachmentsService, AttachmentStatusPagedResponse, UploadStatus } from '../../../src/services/attachmentsService';
import { logger } from '../../../src/utils/logger';
import ZoteroAttachmentList from '../ui/ZoteroAttachmentList';
import Button from '../ui/Button';
import Tooltip from '../ui/Tooltip';
import { retryUploadsByStatus } from "../../../src/services/FileUploader";
import { FailedFileReference } from '../../types/zotero';
import { Icon, ArrowDownIcon, ArrowRightIcon, RepeatIcon } from '../icons/icons';
import IconButton from '../ui/IconButton';
import { store } from '../../../react/store';
import { planFeaturesAtom } from '../../atoms/profile';

const ITEMS_PER_PAGE = 10;

interface PaginatedFailedUploadsListProps {
    statuses: UploadStatus[];
    count: number;
    title: string;
    tooltipTitle: string;
    tooltipContent?: React.ReactNode;
    icon: React.ComponentType<any>;
    textColorClassName?: string;
    retryButton?: boolean;
}

const PaginatedFailedUploadsList: React.FC<PaginatedFailedUploadsListProps> = ({
    statuses,
    count,
    title,
    tooltipTitle,
    tooltipContent,
    icon,
    textColorClassName = 'font-color-secondary',
    retryButton = false,
}) => {
    const [showList, setShowList] = useState(false);
    const [attachments, setAttachments] = useState<FailedFileReference[]>([]);
    const [currentPage, setCurrentPage] = useState(0);
    const [hasMore, setHasMore] = useState(false);
    const [isLoading, setIsLoading] = useState(false);

    // Track previous count to detect actual changes
    const prevCountRef = useRef<number>();

    const userId = useAtomValue(userIdAtom);

    const getErrorMessage = async (attachment: Zotero.Item | false) => {
        if(!attachment) return "file_missing"
        if(!attachment.isAttachment()) return "file_missing"

        // Reason: missing file
        let filePath: string | null = null;
        filePath = await attachment.getFilePathAsync() || null;
        if(!filePath) return "file_missing"

        // Reason: file size limit
        const fileSize = await Zotero.Attachments.getTotalFileSize(attachment);
        const fileSizeInMB = fileSize / 1024 / 1024; // convert to MB
        const sizeLimit = store.get(planFeaturesAtom).uploadFileSizeLimit;
        if (fileSizeInMB > sizeLimit) return 'plan_limit_file_size';

        return 'unexpected_error';
    }

    const fetchItems = useCallback(async (page: number) => {
        if (!userId || isLoading) return;

        setIsLoading(true);
        try {
            const result: AttachmentStatusPagedResponse = await attachmentsService.getAttachmentsByUploadStatus(
                statuses,
                page + 1, // API is 1-based
                ITEMS_PER_PAGE
            );

            logger(`PaginatedFailedUploadsList: ${result.items.length} items found for page ${page + 1}`, 3);

            const newItems = await Promise.all(result.items.map(async (item) => {
                const attachment = await Zotero.Items.getByLibraryAndKeyAsync(item.library_id, item.zotero_key);
                const errorCode = await getErrorMessage(attachment);

                return {
                    file_hash: item.file_hash || '',
                    library_id: item.library_id,
                    zotero_key: item.zotero_key,
                    errorCode: errorCode,
                } as FailedFileReference;
            }));

            setAttachments(prevItems => {
                const combinedItems = [...(prevItems || []), ...newItems];
                const uniqueItems = combinedItems.filter((item, index, arr) => 
                    arr.findIndex(other => 
                        other.library_id === item.library_id && other.zotero_key === item.zotero_key
                    ) === index
                );
                return uniqueItems;
            });
            setHasMore(result.has_more);
            setCurrentPage(page);
        } catch (error) {
            logger(`PaginatedFailedUploadsList: Error fetching ${statuses.join(', ')} items: ${error}`);
            setAttachments([]);
            setHasMore(false);
        } finally {
            setIsLoading(false);
        }
    }, [userId, statuses]);

    useEffect(() => {
        if (!userId || count === 0) {
            setAttachments([]);
            setCurrentPage(0);
            setHasMore(false);
            setShowList(false);
            prevCountRef.current = 0;
            return;
        }

        // Only fetch if showList is true AND count has actually changed
        if (showList && prevCountRef.current !== count) {
            prevCountRef.current = count;
            fetchItems(0);
        }
    }, [userId, count, showList, fetchItems]);

    useEffect(() => {
        if (showList && count > 0) {
            const currentlyFetchedCount = attachments.length;
            setHasMore(count > currentlyFetchedCount);
        }
    }, [count, attachments.length, showList]);

    const handleToggleShowList = () => {
        setShowList(prevShow => !prevShow);
    };

    const handleShowMore = () => {
        if (hasMore && !isLoading) {
            fetchItems(currentPage + 1);
        }
    };

    if (count === 0) {
        return null;
    }

    return (
        <div className="display-flex flex-col gap-4 min-w-0">
            <div className="display-flex flex-row gap-4 min-w-0">
                <div className="flex-shrink-0">
                    <Icon icon={icon} className={`scale-12 mt-15 ${textColorClassName}`} />
                </div>
                <div className="display-flex flex-col items-start gap-3 w-full min-w-0">
                    <div className="display-flex flex-row items-start gap-3 w-full">
                        <Tooltip
                            content={tooltipTitle}
                            customContent={tooltipContent}
                            showArrow={true}
                            disabled={count === 0 || !tooltipContent}
                            placement="top"
                        >
                            <Button
                                variant="ghost"
                                onClick={handleToggleShowList}
                                rightIcon={showList ? ArrowDownIcon : ArrowRightIcon}
                                iconClassName={`mr-0 mt-015 scale-12 ${textColorClassName}`}
                            >
                                <span className={`text-base ${textColorClassName}`} style={{ marginLeft: '-3px' }}>
                                    {count.toLocaleString()} {title}
                                </span>
                            </Button>
                        </Tooltip>
                        <div className="flex-1" />
                        {retryButton && (
                            <IconButton
                                variant="ghost"
                                onClick={async () => {
                                    await retryUploadsByStatus("failed");
                                    setShowList(false);
                                }}
                                icon={RepeatIcon}
                                iconClassName="font-color-secondary"
                                className="scale-11"
                            />
                        )}
                    </div>
                    {showList && (
                        <div className="display-flex flex-col gap-2 w-full">
                            <ZoteroAttachmentList
                                attachments={attachments}
                                maxHeight="250px"
                            />
                            {hasMore && (
                                <Button
                                    variant="ghost"
                                    rightIcon={isLoading ? undefined : ArrowDownIcon}
                                    loading={isLoading}
                                    iconClassName={`scale-11 ${isLoading ? 'animate-spin' : ''}`}
                                    className="fit-content"
                                    onClick={handleShowMore}
                                    disabled={isLoading || !hasMore}
                                >
                                    {isLoading ? "Loading..." : "Show More"}
                                </Button>
                            )}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

export default PaginatedFailedUploadsList;