const getAPIBaseURL = () => process.env.API_BASE_URL;

const API_BASE_URL = getAPIBaseURL() || '';
export default API_BASE_URL;