#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p build/module-cache
xcrun swiftc -swift-version 5 -module-cache-path "$PWD/build/module-cache" Sources/PCMConverter.swift Tests/main.swift -o build/pcm-tests -framework AVFoundation
build/pcm-tests
