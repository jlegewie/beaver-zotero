import React, { useState } from 'react';
import { ProcessingStatus } from '../../../src/services/attachmentsService';
import ZoteroAttachmentList from '../ui/ZoteroAttachmentList';
import Button from '../ui/Button';
import Tooltip from '../ui/Tooltip';
import { Icon, ArrowDownIcon, ArrowRightIcon } from '../icons/icons';
import { usePaginatedAttachmentStatusList } from '../../hooks/usePaginatedAttachmentStatusList';

interface ExpandableAttachmentListProps {
    statuses: ProcessingStatus[];
    count: number;
    title: string;
    tooltipTitle: string;
    tooltipContent?: React.ReactNode;
    icon: React.ComponentType<any>;
    textColorClassName?: string;
}

const ExpandableAttachmentList: React.FC<ExpandableAttachmentListProps> = ({
    statuses,
    count,
    title,
    tooltipTitle,
    tooltipContent,
    icon,
    textColorClassName = 'font-color-secondary',
}) => {
    const [showList, setShowList] = useState(false);
    const {
        attachments,
        hasMore,
        isLoading,
        fetchNextPage,
    } = usePaginatedAttachmentStatusList(statuses, showList, count);

    const handleToggleShowList = () => {
        setShowList((prev) => !prev);
    };

    const handleShowMore = () => {
        fetchNextPage();
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

export default ExpandableAttachmentList;