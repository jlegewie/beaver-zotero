import React from 'react';
import { CSSItemTypeIcon } from '../icons';
import { FileSource } from '../../types/sources';
import PreviewHeading from './PreviewHeading';

interface PreviewFileSourceProps {
    source: FileSource;
}

const PreviewFileSource: React.FC<PreviewFileSourceProps> = ({ source }) => {
    return (
        <div className="flex flex-col gap-2">
            <PreviewHeading source={source} />
            <p className="text-base my-2 overflow-hidden text-ellipsis">{source.filePath}</p>
        </div>
    );
};

export default PreviewFileSource;