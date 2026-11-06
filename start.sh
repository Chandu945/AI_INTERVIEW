#!/usr/bin/env bash
# For everyday use: builds the optimized frontend, then serves it on port 3000 with the
# backend on port 8000. Faster than dev mode. Ctrl+C stops both.
set -euo pipefail
cd "$(dirname "$0")"
. scripts/lib.sh

check_setup
echo "Building the frontend..."
(cd frontend && npm run build)
run_both ".venv/bin/uvicorn main:app --port 8000" "npm run start"
