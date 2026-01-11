#!/bin/bash
# Pre-tool-use hook for multi-harness smoke testing
# WHY: Verifies hook script execution during smoke tests

echo "Pre-tool-use hook executed"
echo "Tool: ${ASP_TOOL_NAME:-unknown}"
echo "Harness: ${ASP_HARNESS:-unknown}"
