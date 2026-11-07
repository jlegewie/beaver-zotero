import React from "react";

type CsvIconProps = React.SVGProps<SVGSVGElement>;

const CsvIcon: React.FC<CsvIconProps> = (props) => (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width={24} height={24} color={"currentColor"} fill={"none"} {...props}>
        <path d="M20 13V10.6569C20 9.83935 20 9.4306 19.8478 9.06306C19.6955 8.69552 19.4065 8.40649 18.8284 7.82843L14.0919 3.09188C13.593 2.593 13.3436 2.34355 13.0345 2.19575C12.9702 2.165 12.9044 2.13772 12.8372 2.11401C12.5141 2 12.1614 2 11.4558 2C8.21082 2 6.58831 2 5.48933 2.88607C5.26731 3.06508 5.06508 3.26731 4.88607 3.48933C4 4.58831 4 6.21082 4 9.45584V13M13 2.5V3C13 5.82843 13 7.24264 13.8787 8.12132C14.7574 9 16.1716 9 19 9H19.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"></path>
        <path d="M7.75 16.75C7.3843 16.2949 6.8432 16 6.25 16C5.1454 16 4.25 16.8954 4.25 18V20C4.25 21.1046 5.1454 22 6.25 22C6.8432 22 7.3843 21.7051 7.75 21.25M13.5 16.5C13.1 16.2 12.6 16 12 16C11.03 16 10.25 16.67 10.25 17.5C10.25 18.33 11.03 19 12 19C12.97 19 13.75 19.67 13.75 20.5C13.75 21.33 12.97 22 12 22C11.4 22 10.9 21.8 10.5 21.5M16.25 16L18 22L19.75 16" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"></path>
    </svg>
);

export default CsvIcon;
