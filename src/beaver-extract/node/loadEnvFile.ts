/**
 * Loads `.env` from the working directory into `process.env`, when the file
 * exists. Variables already set in the environment keep their values.
 * Import it before anything that reads the environment.
 */
try {
    process.loadEnvFile();
} catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
