# Shared by dev.sh and start.sh: checks the setup and runs both servers together.

check_setup() {
  if [ ! -x backend/.venv/bin/uvicorn ]; then
    echo "The backend isn't set up yet. See 'First-time setup' in README.md." >&2
    exit 1
  fi
  if [ ! -d frontend/node_modules ]; then
    echo "The frontend isn't set up yet. Run 'npm install' in the frontend folder." >&2
    exit 1
  fi
  if [ ! -f backend/.env ]; then
    echo "backend/.env is missing. Copy backend/.env.example to backend/.env and add your GEMINI_API_KEY." >&2
    exit 1
  fi
}

# Runs the backend and frontend commands side by side. Ctrl+C stops both, and if either one
# stops on its own (say its port is taken), the other is stopped too.
run_both() {
  local backend_command="$1" frontend_command="$2"
  set -m # each server gets its own process group, so stopping it also stops everything it started
  (cd backend && eval "exec $backend_command") &
  local backend=$!
  (cd frontend && eval "exec $frontend_command") &
  local frontend=$!
  trap "trap - EXIT INT TERM; kill -- -$backend -$frontend 2>/dev/null || true" EXIT INT TERM
  echo "Starting... then open http://localhost:3000   (Ctrl+C stops both servers)"
  while kill -0 "$backend" 2>/dev/null && kill -0 "$frontend" 2>/dev/null; do
    sleep 1
  done
}
