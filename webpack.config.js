import path from 'path';
import { fileURLToPath } from 'url';
import webpack from 'webpack';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load environment variables based on mode
const loadEnv = (mode) => {
    const envFile = mode === 'production' ? '.env.production' : '.env.development';
    const result = dotenv.config({ path: envFile });

    if (result.error) {
        return {};
    }

    return result.parsed;
};

export default (env, argv) => {
    const mode = argv.mode || 'development';
    const envVars = loadEnv(mode);

    return {
        mode,
        target: 'web',
        entry: './react/index.tsx',
        devtool: mode === 'production' ? false : 'inline-source-map',
        output: {
            path: path.resolve(__dirname, 'addon', 'content'),
            filename: 'reactBundle.js',
            libraryTarget: 'umd',
            globalObject: 'this',
            umdNamedDefine: true
        },
        module: {
            rules: [
            {
                test: /\.(js|jsx|ts|tsx)$/,
                exclude: /node_modules/,
                use: {
                    loader: 'babel-loader',
                    options: {
                        presets: [
                            ['@babel/preset-env', { targets: { esmodules: false } }],
                            '@babel/preset-react',
                            '@babel/preset-typescript'
                        ]
                    }
                }
            }
            ]
        },
        resolve: {
            extensions: ['.js', '.jsx', '.ts', '.tsx'],
        },
        plugins: [
            new webpack.DefinePlugin({
                'process.env.NODE_ENV': JSON.stringify(mode),
                'process.env.SUPABASE_URL': JSON.stringify(envVars.SUPABASE_URL),
                'process.env.SUPABASE_ANON_KEY': JSON.stringify(envVars.SUPABASE_ANON_KEY),
                'process.env.API_BASE_URL': JSON.stringify(envVars.API_BASE_URL)
            })
        ]
    };
};