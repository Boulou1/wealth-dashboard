#!/bin/bash
# Double-click this file to open your Wealth dashboard.
# It serves the app locally and opens it in your browser.
# Leave the Terminal window open while using it; close it (or press Ctrl-C) to stop.

cd "$(dirname "$0")" || exit 1
PORT=8778
URL="http://localhost:$PORT"

# If it's already running, just open the browser.
if curl -s -o /dev/null "$URL"; then
  echo "Dashboard is already running — opening $URL"
  open "$URL"
  exit 0
fi

echo "Starting your Wealth dashboard at $URL"
echo "Keep this window open while using the app. Close it (or press Ctrl-C) to stop."
echo ""
( sleep 1; open "$URL" ) &
python3 -m http.server "$PORT"
