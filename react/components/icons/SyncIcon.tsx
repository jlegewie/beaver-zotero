import React from "react";

type SyncIconProps = React.SVGProps<SVGSVGElement>;

const SyncIcon: React.FC<SyncIconProps> = (props) => (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width={24} height={24} color={"#000000"} fill={"none"} {...props}>
        <path
            fill="currentColor"
            d="M9.885 3.75a6.25 6.25 0 0 0-3.628 11.256a.75.75 0 0 1-.9 1.2a7.75 7.75 0 0 1 3.99-13.93l-.584-.586A.75.75 0 0 1 9.823.63l2.122 2.121a.75.75 0 0 1 0 1.06L9.823 5.934a.75.75 0 0 1-1.06-1.06zm.23 12.498a6.25 6.25 0 0 0 3.628-11.256a.75.75 0 0 1 .9-1.2q.439.33.837.727a7.75 7.75 0 0 1-4.828 13.203l.585.585a.75.75 0 1 1-1.06 1.061l-2.122-2.121a.75.75 0 0 1 0-1.06l2.122-2.122a.75.75 0 1 1 1.06 1.06z"
        ></path>
    </svg>
);

export default SyncIcon;
