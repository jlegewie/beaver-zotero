import React from "react";
import Button from "../../ui/Button";

interface UpgradeCardProps {
    /** Title of the upgrade card */
    title?: string;
    /** Description text */
    description?: string;
    /** Button label */
    buttonLabel?: string;
    /** Click handler for the upgrade button */
    onUpgradeClick?: () => void;
}

/**
 * Reusable upgrade prompt card for Free users
 * Displays upgrade benefits and a button to start the upgrade process
 */
const UpgradeCard: React.FC<UpgradeCardProps> = ({
    title = "Upgrade to Pro",
    description = "Search the full content of your PDFs, get answers with sentence-level citations and more.",
    buttonLabel = "Upgrade",
    onUpgradeClick
}) => {
    const handleClick = () => {
        if (onUpgradeClick) {
            onUpgradeClick();
        } else {
            // Default: open pricing page
            Zotero.launchURL(process.env.WEBAPP_BASE_URL + '/pricing');
        }
    };

    return (
        <div className="p-3 rounded-md bg-senary">
            <div className="display-flex flex-col gap-2">
                <div className="display-flex flex-row justify-between items-center mb-1">
                    <div className="font-medium">{title}</div>
                    <Button variant="outline" onClick={handleClick}>
                        {buttonLabel}
                    </Button>
                </div>
                <div className="text-sm font-color-secondary">
                    {description}
                </div>
            </div>
        </div>
    );
};

export default UpgradeCard;

