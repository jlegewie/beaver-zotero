const path = require('path');

module.exports = {
    mode: 'development',    // or 'development' for easier debugging
    target: 'web',
    entry: './src/react/index.jsx',  // your entry file
    devtool: 'inline-source-map',
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
};
