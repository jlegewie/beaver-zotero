const getAPIBaseURL = () => {
    // @ts-ignore Zotero.Beaver is defined
    return Zotero.Beaver.env === 'development'
        ? 'http://localhost:8000'
        : 'http://localhost:8000';
};

const API_BASE_URL = getAPIBaseURL();
export default API_BASE_URL;