import React from 'react'
import { InputSource } from '../types/sources'
import Tooltip from './Tooltip'


export interface MissingSourceButtonProps {
    source: InputSource
}

const MissingSourceButton: React.FC<MissingSourceButtonProps> = ({
    source
}) => {
    return (
        <Tooltip content="Item not found in library.">
            <button className="variant-outline source-button">
                <span className="font-color-red">
                        Missing Item
                </span>
            </button>
        </Tooltip>
    )
}

export default MissingSourceButton;