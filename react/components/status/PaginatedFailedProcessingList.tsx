import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useAtomValue } from 'jotai';
import { userIdAtom } from '../../atoms/auth';
import { planFeaturesAtom } from '../../atoms/profile';
import { attachmentsService, AttachmentStatusPagedResponse, ProcessingStatus } from '../../../src/services/attachmentsService';
import { logger } from '../../../src/utils/logger';
import ZoteroAttachmentList from '../ui/ZoteroAttachmentList';
import Button from '../ui/Button';
import Tooltip from '../ui/Tooltip';
import { FailedFileReference } from '../../types/zotero';
import { Icon, ArrowDownIcon, ArrowRightIcon, RepeatIcon } from '../icons/icons';
import { getMimeType } from '../../../src/utils/zoteroUtils';

const ITEMS_PER_PAGE = 10;

interface PaginatedFailedProcessingListProps {
    statuses: ProcessingStatus[];
    count: number;
    title: string;
    tooltipTitle: string;
    tooltipContent?: React.ReactNode;
    icon: React.ComponentType<any>;
    textColorClassName?: string;
}

const PaginatedFailedProcessingList: React.FC<PaginatedFailedProcessingListProps> = ({
    statuses,
    count,
    title,
    tooltipTitle,
    tooltipContent,
    icon,
    textColorClassName = 'font-color-secondary',
}) => {
    const [showList, setShowList] = useState(false);
    const [attachments, setAttachments] = useState<FailedFileReference[]>([]);
    const [currentPage, setCurrentPage] = useState(0);
    const [hasMore, setHasMore] = useState(false);
    const [isLoading, setIsLoading] = useState(false);

    const prevCountRef = useRef<number>();

    const userId = useAtomValue(userIdAtom);
    const planFeatures = useAtomValue(planFeaturesAtom);

    const processingTier = useMemo(() => planFeatures.processingTier, [planFeatures.processingTier]);

    const fetchItems = useCallback(async (page: number) => {
        if (!userId || isLoading) return;

        setIsLoading(true);
        try {
            const result: AttachmentStatusPagedResponse = await attachmentsService.getAttachmentsByStatus(
                statuses,
                processingTier,
                page + 1, // API is 1-based
                ITEMS_PER_PAGE
            );

            const newItems = await Promise.all(result.items.map(async (item) => {
                let enableRetry = false;
                let fileHash: string | undefined = undefined;
                const zoteroItem = await Zotero.Items.getByLibraryAndKeyAsync(item.library_id, item.zotero_key);
                if (zoteroItem && zoteroItem.isAttachment()) {
                    fileHash = await zoteroItem.attachmentHash;
                    if (fileHash !== item.file_hash) enableRetry = true;
                }
                let errorCode = item.text_error_code;
                if(planFeatures.processingTier === 'standard') {
                    errorCode = item.md_error_code;
                } else if(planFeatures.processingTier === 'advanced') {
                    errorCode = item.docling_error_code;
                }

                return {
                    file_hash: item.file_hash || '',
                    library_id: item.library_id,
                    zotero_key: item.zotero_key,
                    errorCode: errorCode,
                    buttonText: enableRetry && fileHash ? 'Retry' : undefined,
                    buttonAction: enableRetry && fileHash ? async () => {
                        const zoteroItem = await Zotero.Items.getByLibraryAndKeyAsync(item.library_id, item.zotero_key);
                        if(!zoteroItem || !zoteroItem.isAttachment()) return;
                        const mimeType = await getMimeType(zoteroItem);
                        await attachmentsService.updateFile(item.library_id, item.zotero_key, fileHash, mimeType);
                    } : undefined,
                    buttonIcon: enableRetry && fileHash ? RepeatIcon : undefined,
                } as FailedFileReference;
            }));

            setAttachments(prevItems => (page === 0 ? newItems : [...prevItems, ...newItems]));
            setHasMore(result.has_more);
            setCurrentPage(page);
        } catch (error) {
            logger(`PaginatedFailedProcessingList: Error fetching ${statuses.join(', ')} items: ${error}`);
            setAttachments([]);
            setHasMore(false);
        } finally {
            setIsLoading(false);
        }
    }, [userId, processingTier, statuses]);

    useEffect(() => {
        if (!userId || count === 0) {
            setAttachments([]);
            setCurrentPage(0);
            setHasMore(false);
            setShowList(false);
            prevCountRef.current = 0;
            return;
        }

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

export default PaginatedFailedProcessingList;