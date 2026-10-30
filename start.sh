#!/bin/bash
# Starts the .NET backend (http://localhost:5100) and the Vite front end (http://localhost:3000).
set -e
ROOT="$(cd "$(dirname "$0")" && pwd)"

echo "Starting the backend on http://localhost:5100"
(cd "$ROOT/backend" && dotnet run --launch-profile http) &
BACKEND_PID=$!

echo "Starting the front end on http://localhost:3000"
(cd "$ROOT/frontend" && npx vite --port 3000) &
FRONTEND_PID=$!

echo "Open http://localhost:3000. Press Ctrl+C to stop both servers."
trap "kill $BACKEND_PID $FRONTEND_PID 2>/dev/null; exit" INT TERM
wait
