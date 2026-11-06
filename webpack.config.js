import path from 'path';
import { fileURLToPath } from 'url';
import webpack from 'webpack';
import { loadBuildEnvironment } from './build-env.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default (env, argv) => {
    const { mode, buildEnv, definitions } = loadBuildEnvironment({ mode: argv.mode });

    return {
        mode,
        target: 'web',
        entry: './react/index.tsx',
        devtool: mode === 'development' ? 'inline-source-map' : false,
        output: {
            path: path.resolve(__dirname, 'addon', 'content'),
            filename: 'reactBundle.js',
            library: 'BeaverReact',
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
            alias: {
                '@beaver/agent-core': path.resolve(__dirname, 'packages', 'agent-core', 'src'),
                '@beaver/agent-ui': path.resolve(__dirname, 'packages', 'agent-ui', 'src'),
                '@beaver/agent-export': path.resolve(__dirname, 'packages', 'agent-export', 'src'),
                // The package's `browser` build decodes `&rsquo;` and other
                // named entities by assigning them to `innerHTML`. Zotero's
                // windows are XHTML documents, whose XML parser throws on any
                // entity but the five XML built-ins, so Markdown containing
                // `&nbsp;` would throw during render. The default build looks
                // entities up in a table instead.
                'decode-named-character-reference$': path.resolve(
                    __dirname, 'node_modules', 'decode-named-character-reference', 'index.js'
                )
            },
        },
        plugins: [
            new webpack.DefinePlugin({
                'process.env.NODE_ENV': JSON.stringify(mode),
                'process.env.BUILD_ENV': JSON.stringify(buildEnv),
                ...definitions
            })
        ]
    };
};