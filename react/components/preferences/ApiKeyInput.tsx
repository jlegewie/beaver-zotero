import React, { useState, useEffect } from "react";
import { LinkIcon, ArrowRightIcon, Spinner, TickIcon, AlertIcon } from '../icons/icons';
import IconButton from "../ui/IconButton";
import Button from "../ui/Button";
import { useSetAtom } from 'jotai';
import { chatService, ErrorType } from '../../../src/services/chatService';
import { ProviderType } from '../../atoms/models';
import { logger } from "../../../src/utils/logger";
import { validateSelectedModelAtom } from '../../atoms/models';


interface ApiKeyInputProps {
    id: string;
    label: string;
    provider: ProviderType;
    linkUrl?: string;
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
    className?: string;
    savePref: (value: string) => void;
}


const ApiKeyInput: React.FC<ApiKeyInputProps> = ({
    id,
    label,
    provider,
    linkUrl,
    value,
    onChange,
    placeholder = "Enter your API Key",
    className = "",
    savePref
}) => {
    const [isVerifying, setIsVerifying] = useState(false);
    const [verificationStatus, setVerificationStatus] = useState<'idle' | 'success' | 'error'>('idle');
    const [verificationError, setVerificationError] = useState<ErrorType | null>(null);
    const [currentValue, setCurrentValue] = useState(value);
    const validateSelectedModel = useSetAtom(validateSelectedModelAtom);

    useEffect(() => {
        setCurrentValue(value);
        setVerificationStatus('idle');
        setVerificationError(null);
    }, [value]);

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const newValue = e.target.value;
        setCurrentValue(newValue);
        onChange(newValue);
        if (newValue === '') {
            savePref(newValue);
            validateSelectedModel();
        }
        if (verificationStatus !== 'idle') {
            setVerificationStatus('idle');
            setVerificationError(null);
        }
    };

    const handleVerify = async () => {
        setIsVerifying(true);
        setVerificationStatus('idle');
        setVerificationError(null);

        try {
            const result = await chatService.verifyApiKey(provider, currentValue);
            if (result.valid) {
                setVerificationStatus('success');
                savePref(currentValue);
                logger(`API Key for ${provider} verified and saved.`);
                validateSelectedModel();
            } else {
                setVerificationStatus('error');
                setVerificationError(result.error_type || 'UnexpectedError');
                console.error(`API Key verification failed for ${provider}: ${result.error_type}`);
            }
        } catch (error) {
            console.error("Error during API key verification:", error);
            setVerificationStatus('error');
            setVerificationError('UnexpectedError');
        } finally {
            setIsVerifying(false);
        }
    };

    const getButtonContent = () => {
        if (isVerifying) {
            return { text: 'Verify', icon: Spinner };
        }
        switch (verificationStatus) {
            case 'success':
                return { text: 'Verified', icon: TickIcon };
            case 'error':
                // let errorText = 'Verification Failed';
                // if (verificationError === 'AuthenticationError') errorText = 'Invalid Key';
                // else if (verificationError === 'RateLimitError') errorText = 'Rate Limited';
                // else if (verificationError === 'PermissionDeniedError') errorText = 'Permission Denied';
                // else if (verificationError === 'UnexpectedError') errorText = 'Verification Failed';
                return { text: "Failed", icon: AlertIcon };
            case 'idle':
            default:
                return { text: 'Verify', icon: ArrowRightIcon };
        }
    };

    const { text: buttonText, icon: buttonIcon } = getButtonContent();
    const inputBorderColor = verificationStatus === 'error' ? 'border-error' : 'border-quinary';
    // const buttonVariant = verificationStatus === 'error' ? 'danger' : 'outline';
    const buttonVariant = 'outline';

    return (
        <div className={`display-flex flex-col items-start gap-1 mt-1 mb-1 ${className}`}>
            <div className="display-flex flex-row items-start gap-1 flex-1 w-full">
                <label htmlFor={id} className="text-sm font-semibold font-color-primary">{label}</label>
                {linkUrl && (
                    <IconButton
                        variant="ghost-secondary"
                        icon={LinkIcon}
                        onClick={() => Zotero.getActiveZoteroPane().loadURI(linkUrl)}
                        className="scale-11 p-0"
                        ariaLabel="Read more"
                    />
                )}
            </div>
            <div className="display-flex flex-row items-start gap-2 mt-1 mb-1 flex-1 w-full">
                <input
                    id={id}
                    type="password"
                    value={currentValue}
                    onChange={handleChange}
                    placeholder={placeholder}
                    className={`flex-1 p-1 m-0 border text-sm rounded-sm ${inputBorderColor} bg-senary focus:border-tertiary outline-none`}
                    aria-invalid={verificationStatus === 'error'}
                />
                <Button
                    variant={buttonVariant}
                    style={{ padding: "3px 6px" }}
                    rightIcon={buttonIcon}
                    onClick={handleVerify}
                    disabled={isVerifying || !currentValue}
                >
                    {buttonText}
                </Button>
            </div>
        </div>
    );
};

export default ApiKeyInput;