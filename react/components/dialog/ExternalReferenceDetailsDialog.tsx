import React, { useEffect } from 'react';
import { useAtom, useAtomValue } from 'jotai';
import { 
    isExternalReferenceDetailsDialogVisibleAtom, 
    selectedExternalReferenceAtom 
} from '../../atoms/ui';
import ExternalReferenceDetails from '../externalReferences/ExternalReferenceDetails';
import { CancelIcon } from '../icons/icons';
import IconButton from '../ui/IconButton';

const ExternalReferenceDetailsDialog: React.FC = () => {
    const [isVisible, setIsVisible] = useAtom(isExternalReferenceDetailsDialogVisibleAtom);
    const item = useAtomValue(selectedExternalReferenceAtom);

    // Handle ESC key to close dialog
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && isVisible) {
                setIsVisible(false);
            }
        };

        if (isVisible) {
            Zotero.getMainWindow().document.addEventListener('keydown', handleKeyDown);
            return () => Zotero.getMainWindow().document.removeEventListener('keydown', handleKeyDown);
        }
    }, [isVisible, setIsVisible]);

    if (!item) return null;

    return (
        <div 
            className="relative display-flex flex-col rounded-md bg-quaternary shadow-md shadow-md-top overflow-hidden"
            style={{ width: '90%', maxHeight: '80vh' }}
            onClick={(e) => e.stopPropagation()}
        >
            <div className="display-flex flex-row pt-2 px-2">
                <div className="flex-1" />
                <IconButton
                    icon={CancelIcon}
                    onClick={() => setIsVisible(false)}
                    className="scale-12"
                    ariaLabel="Close"
                />

            </div>

            <ExternalReferenceDetails item={item} />
        </div>
    );
};

export default ExternalReferenceDetailsDialog;

