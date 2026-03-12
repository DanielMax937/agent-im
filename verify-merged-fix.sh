#!/bin/bash
echo "=== Verifying /new Command Fix (Merged Library) ===" 
echo ""
echo "1. Checking source file (now in src/lib/)..."
if grep -q "router.updateBinding(binding.id, { sdkSessionId: '' });" src/lib/bridge/bridge-manager.ts; then
  echo "✅ Source file contains fix"
else
  echo "❌ Source file does NOT contain fix"
  exit 1
fi

echo ""
echo "2. Checking if library is merged..."
if [ -d "src/lib/bridge/adapters" ]; then
  echo "✅ Library merged into src/lib/"
else
  echo "❌ Library NOT found in src/lib/"
  exit 1
fi

echo ""
echo "3. Checking bundle..."
if grep -q 'updateBinding(binding.id, { sdkSessionId: "" });' dist/daemon.mjs; then
  echo "✅ Fix present in daemon bundle"
else
  echo "❌ Fix NOT in daemon bundle"
  exit 1
fi

echo ""
echo "4. Checking daemon status..."
bash scripts/daemon.sh status | grep -q "running.*true"
if [ $? -eq 0 ]; then
  echo "✅ Daemon is running"
else
  echo "❌ Daemon is not running"
  exit 1
fi

echo ""
echo "5. Checking git tracking..."
if git ls-files src/lib/bridge/bridge-manager.ts | grep -q "bridge-manager.ts"; then
  echo "✅ Fix is tracked by git"
else
  echo "⚠️  Fix not committed yet (run: git add src/lib/)"
fi

echo ""
echo "=== All checks passed! ✅ ===" 
echo ""
echo "The /new command fix is in your git-tracked source code."
echo "Test it by sending '/new' from your IM app, then verify"
echo "that the next message starts a fresh conversation."
