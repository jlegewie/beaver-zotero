import React from 'react';
import { CSSItemTypeIcon } from '../icons';
import { FileSource } from '../../types/resources';

interface PreviewFileSourceProps {
    source: FileSource;
}

const PreviewFileSource: React.FC<PreviewFileSourceProps> = ({ source }) => {
    return (
        <div className="flex flex-col gap-2">
            <span className="flex items-center font-color-primary">
                {<CSSItemTypeIcon itemType={source.icon} />}
                <span className="ml-2">{source.name}</span>
            </span>
            <p className="text-base my-2">{source.filePath}</p>
        </div>
    );
};

export default PreviewFileSource;