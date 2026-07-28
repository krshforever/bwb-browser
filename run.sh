#!/data/data/com.termux/files/usr/bin/bash
export NODE_PATH="/data/data/com.termux/files/usr/lib/node_modules"
exec node "$(dirname "$0")/server.js" "$@"
