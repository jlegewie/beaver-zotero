import React, { useState, useEffect, useCallback } from 'react';
import { useAtomValue } from 'jotai';
import { userIdAtom } from '../../atoms/auth';
import { planFeaturesAtom } from '../../atoms/profile';
import { attachmentsService, AttachmentStatusPagedResponse } from '../../../src/services/attachmentsService';
import { logger } from '../../../src/utils/logger';
import ZoteroAttachmentList from '../ui/ZoteroAttachmentList';
import Button from '../ui/Button';
import Tooltip from '../ui/Tooltip';
import { FailedFileReference } from '../../types/zotero';
import { Icon, ArrowDownIcon, ArrowRightIcon } from '../icons/icons';

const ITEMS_PER_PAGE = 10;

interface ExpandableAttachmentListProps {
    status: 'failed' | 'skipped';
    count: number;
    title: string;
    tooltipTitle: string;
    tooltipContent?: React.ReactNode;
    icon: React.ComponentType<any>;
    textColorClassName?: string;
}

const ExpandableAttachmentList: React.FC<ExpandableAttachmentListProps> = ({
    status,
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

    const userId = useAtomValue(userIdAtom);
    const planFeatures = useAtomValue(planFeaturesAtom);

    const fetchItems = useCallback(async (page: number) => {
        if (!userId || isLoading) return;

        setIsLoading(true);
        try {
            const useAdvancedPipeline = planFeatures.advancedProcessing;
            const result: AttachmentStatusPagedResponse = await attachmentsService.getAttachmentsByStatus(
                status,
                useAdvancedPipeline ? "advanced" : "basic",
                page + 1, // API is 1-based
                ITEMS_PER_PAGE
            );

            const newItems = result.items.map((item) => ({
                file_hash: item.file_hash || '',
                library_id: item.library_id,
                zotero_key: item.zotero_key,
                errorCode: useAdvancedPipeline ? item.docling_error_code : item.md_error_code,
            } as FailedFileReference));

            setAttachments(prevItems => (page === 0 ? newItems : [...prevItems, ...newItems]));
            setHasMore(result.has_more);
            setCurrentPage(page);
        } catch (error) {
            logger(`ExpandableAttachmentList: Error fetching ${status} items: ${error}`);
            setAttachments([]);
            setHasMore(false);
        } finally {
            setIsLoading(false);
        }
    }, [userId, planFeatures.advancedProcessing, status]);

    useEffect(() => {
        if (!userId || count === 0) {
            setAttachments([]);
            setCurrentPage(0);
            setHasMore(false);
            setShowList(false);
            return;
        }

        if (showList) {
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
                                    rightIcon={ArrowDownIcon}
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

export default ExpandableAttachmentList;