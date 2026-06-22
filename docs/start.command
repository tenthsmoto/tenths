#!/bin/bash
# Double-click this file to launch MotoGP Analytics locally.
cd "$(dirname "$0")/.."

PORT=8080
URL="http://localhost:${PORT}/frontend/"

echo ""
echo "  ◈ MotoGP Analytics"
echo "  ──────────────────────────────────────"
echo "  Serving from: $(pwd)"
echo "  Opening:      ${URL}"
echo ""
echo "  Press Ctrl+C to stop the server."
echo ""

# Open the browser after a short delay so the server has time to start
(sleep 1 && open "${URL}") &

python3 -m http.server ${PORT}
