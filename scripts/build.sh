#!/bin/bash
# @dsh-external/dsh-agent-outputs-reader：纯 JS 插件，无外部构建依赖。
# src/ -> lib/ 直接拷贝 + 语法自检 + src↔lib 一致性校验。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

rm -rf lib
mkdir -p lib
cp src/index.js lib/index.js
cp src/client/index.js lib/client.js

node --check lib/index.js
node --check lib/client.js
cmp src/index.js lib/index.js
cmp src/client/index.js lib/client.js

echo "=== dsh-agent-outputs-reader build complete ==="
ls -la lib
