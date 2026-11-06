#!/usr/bin/env bash
# For changing code: the backend on port 8000 reloads when Python files change, and the
# frontend on port 3000 (Turbopack) updates as you save. Ctrl+C stops both.
set -euo pipefail
cd "$(dirname "$0")"
. scripts/lib.sh

check_setup
run_both ".venv/bin/uvicorn main:app --reload --port 8000" "npm run dev"
