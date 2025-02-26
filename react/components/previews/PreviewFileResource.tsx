import React from 'react';
import { CSSItemTypeIcon } from '../icons';
import { FileResource } from '../../types/resources';

interface PreviewFileResourceProps {
    resource: FileResource;
}

const PreviewFileResource: React.FC<PreviewFileResourceProps> = ({ resource }) => {
    return (
        <div className="flex flex-col gap-2">
            <span className="flex items-center font-color-primary">
                {<CSSItemTypeIcon itemType={resource.icon} />}
                <span className="ml-2">{resource.name}</span>
            </span>
            <p className="text-base my-2">{resource.filePath}</p>
        </div>
    );
};

export default PreviewFileResource;