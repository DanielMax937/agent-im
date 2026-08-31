#!/bin/bash
echo "=== Verifying /new Command Fix ===" 
echo ""
echo "1. Checking patched source file..."
if grep -q "router.updateBinding(binding.id, { sdkSessionId: '' });" node_modules/claude-to-im/src/lib/bridge/bridge-manager.ts; then
  echo "✅ Source file patched correctly"
else
  echo "❌ Source file NOT patched"
  exit 1
fi

echo ""
echo "2. Checking patched compiled file..."
if grep -q "router.updateBinding(binding.id, { sdkSessionId: '' });" node_modules/claude-to-im/dist/lib/bridge/bridge-manager.js; then
  echo "✅ Compiled JS file patched correctly"
else
  echo "❌ Compiled JS file NOT patched"
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
echo "=== All checks passed! ✅ ===" 
echo ""
echo "The /new command fix is properly applied and active."
echo "Test it by sending '/new' from your IM app, then verify"
echo "that the next message starts a fresh conversation."
