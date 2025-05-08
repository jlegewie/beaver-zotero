import React from 'react';
import Button from './button';
import { Spinner } from './icons';
import { useAtomValue } from 'jotai';
import { isChatRequestPendingAtom } from '../atoms/threads';

interface GeneratingButtonProps {
    label?: string;
}

const GeneratingButton: React.FC<GeneratingButtonProps> = ({ label = "Generating..." }) => {
    const isChatRequestPending = useAtomValue(isChatRequestPendingAtom);

    // if (!isChatRequestPending) {
    //     return null;
    // }

    return (
        <div className="px-4">
            <Button
                variant="ghost"
                className="text-base scale-105 disabled-but-styled"
                iconClassName="scale-12"
                icon={Spinner}
                disabled={true}
            >
                <span style={{ marginLeft: '-2px' }}>
                    {label}
                </span>
            </Button>
        </div>
    );
};

export default GeneratingButton;