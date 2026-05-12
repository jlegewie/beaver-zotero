import React from "react";
import { Spinner, ArrowRightIcon, ArrowLeftIcon } from "../../icons/icons";
import Button, { ButtonVariant } from "../../ui/Button";

interface OnboardingFooterProps {
    /** Message displayed on the left side of the footer */
    message?: string;
    /** Button label text */
    buttonLabel: string;
    /** Whether the button action is in progress */
    isLoading?: boolean;
    /** Whether the button is disabled */
    disabled?: boolean;
    /** Click handler for the button */
    onButtonClick: () => void;
    /** Whether to show terms and privacy policy links */
    showTerms?: boolean;
    /** Whether to show a back button */
    showBackButton?: boolean;
    /** Click handler for the back button */
    onBackClick?: () => void;
    /** Label for the back button */
    backButtonLabel?: string;
    /** Visual style for the action button. Defaults to 'solid' so existing
     *  onboarding pages keep their primary CTA. Pass 'ghost' (or another
     *  low-emphasis variant) on screens where the action is a Skip/Cancel
     *  rather than the primary path. */
    buttonVariant?: ButtonVariant;
    /** Hide the right-side arrow/spinner icon. Pair with `buttonVariant='ghost'`
     *  for a clean text-link look. The spinner is still shown when loading. */
    hideRightIcon?: boolean;
}

/**
 * Shared footer component for onboarding pages
 * Displays optional terms links, a message, and an action button
 */
const OnboardingFooter: React.FC<OnboardingFooterProps> = ({
    message,
    buttonLabel,
    isLoading = false,
    disabled = false,
    onButtonClick,
    showTerms = false,
    showBackButton = false,
    onBackClick,
    backButtonLabel = "Back",
    buttonVariant = "solid",
    hideRightIcon = false,
}) => {
    const rightIcon = isLoading
        ? Spinner
        : hideRightIcon
            ? undefined
            : ArrowRightIcon;
    return (
        <div className="p-4 border-top-quinary">
            <div className="display-flex flex-row items-center gap-4">
                {/* Back button */}
                {showBackButton && onBackClick && (
                    <Button
                        variant="ghost"
                        className="fit-content whitespace-nowrap"
                        icon={ArrowLeftIcon}
                        onClick={onBackClick}
                    >
                        {backButtonLabel}
                    </Button>
                )}

                {/* Terms and message area */}
                <div className="font-color-secondary text-sm">
                    {showTerms ? (
                        <>
                            {`By continuing, you agree to our `}
                            <a 
                                className="text-link cursor-pointer" 
                                onClick={() => Zotero.launchURL(process.env.WEBAPP_BASE_URL + '/terms')}
                            >
                                Terms of Service
                            </a>
                            {` and `}
                            <a 
                                className="text-link cursor-pointer" 
                                onClick={() => Zotero.launchURL(process.env.WEBAPP_BASE_URL + '/privacy-policy')}
                            >
                                Privacy Policy
                            </a>.
                        </>
                    ) : (
                        message
                    )}
                </div>

                <div className="flex-1" />

                {/* Action button */}
                <Button
                    variant={buttonVariant}
                    className="fit-content whitespace-nowrap"
                    rightIcon={rightIcon}
                    onClick={onButtonClick}
                    disabled={disabled || isLoading}
                >
                    {buttonLabel}
                </Button>
            </div>
        </div>
    );
};

export default OnboardingFooter;

