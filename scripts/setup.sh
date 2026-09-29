#!/usr/bin/env bash
# 一键安装：Node 依赖 -> 前端构建 -> whisper.cpp（本地编译）-> 语音识别模型
# 所有东西都装在项目目录内，拷贝整个目录即可带走。
# 国内网络下载模型慢的话：HF_ENDPOINT=https://hf-mirror.com npm run setup
set -euo pipefail
cd "$(dirname "$0")/.."

step() { printf '\n\033[1;34m==> %s\033[0m\n' "$1"; }

step "1/4 安装 Node 依赖"
npm install --no-audit --no-fund
npm --prefix web install --no-audit --no-fund

step "2/4 构建前端"
npm --prefix web run build

step "3/4 whisper.cpp"
if [ -x vendor/bin/whisper-cli ] && vendor/bin/whisper-cli -h >/dev/null 2>&1; then
  echo "已存在 vendor/bin/whisper-cli，跳过编译"
else
  command -v cmake >/dev/null || { echo "需要先安装 cmake（macOS: brew install cmake）"; exit 1; }
  if [ ! -f vendor/whisper.cpp/CMakeLists.txt ]; then
    git clone --depth 1 --branch v1.9.4 https://github.com/ggml-org/whisper.cpp.git vendor/whisper.cpp
  fi
  EXTRA=""
  if [ "$(uname)" = "Darwin" ]; then EXTRA="-DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON"; fi
  cmake -S vendor/whisper.cpp -B vendor/whisper.cpp/build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF \
    -DGGML_NATIVE=OFF -DWHISPER_BUILD_TESTS=OFF -DWHISPER_SDL2=OFF $EXTRA
  cmake --build vendor/whisper.cpp/build -j --config Release --target whisper-cli
  mkdir -p vendor/bin
  cp vendor/whisper.cpp/build/bin/whisper-cli vendor/bin/
  rm -rf vendor/whisper.cpp/build
fi

step "4/4 语音识别模型（large-v3-turbo 量化版，约 550MB）"
mkdir -p vendor/models
HF="${HF_ENDPOINT:-https://huggingface.co}"
MODEL=ggml-large-v3-turbo-q5_0.bin
if [ -s "vendor/models/$MODEL" ]; then
  echo "已存在 $MODEL"
else
  curl -L --fail --retry 3 -o "vendor/models/$MODEL.part" "$HF/ggerganov/whisper.cpp/resolve/main/$MODEL"
  mv "vendor/models/$MODEL.part" "vendor/models/$MODEL"
fi

step "完成"
echo "启动：npm start（pm2，端口 3031），然后打开 http://localhost:3031"
