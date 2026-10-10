#!/bin/sh
# Builds "AI Slop Overlay" for Windows: AI-Slop-Overlay-windows.zip
set -e
cd "$(dirname "$0")"
V=44.6.0
npm install --no-audit --no-fund
mkdir -p app/vendor/ort
cp node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm app/vendor/ort/
cp node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.mjs app/
mkdir -p app/tesseract/lang && cp node_modules/tesseract.js/dist/worker.min.js app/tesseract/ && cp node_modules/tesseract.js-core/tesseract-core-*lstm.wasm.js app/tesseract/ && cp node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz app/tesseract/lang/
npx esbuild src/overlay.js --bundle --format=iife --target=chrome130 --outfile=app/overlay.js
npx esbuild src/engine-worker.js --bundle --format=iife --target=chrome130 --outfile=app/engine-worker.js
mkdir -p dl && [ -f dl/electron-win32-x64.zip ] || curl -L -o dl/electron-win32-x64.zip https://github.com/electron/electron/releases/download/v$V/electron-v$V-win32-x64.zip
rm -rf winpkg && mkdir -p "winpkg/AI Slop Overlay" && (cd "winpkg/AI Slop Overlay" && unzip -q ../../dl/electron-win32-x64.zip && rm -f resources/default_app.asar && mkdir -p resources/app && cp -r ../../app/. resources/app/ && mv electron.exe "AI Slop Overlay.exe")
node tools-seticon.mjs
(cd winpkg && rm -f ../AI-Slop-Overlay-windows.zip && zip -qr -9 ../AI-Slop-Overlay-windows.zip "AI Slop Overlay")
echo "built AI-Slop-Overlay-windows.zip"
