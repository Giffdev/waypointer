#!/bin/sh
set -eu

freshclam --stdout --user=node
freshclam --daemon --foreground --checks=12 --user=node &
clamd --foreground=true &

i=0
until clamdscan --ping=1 >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -ge 60 ]; then
    echo "ClamAV failed to become ready" >&2
    exit 1
  fi
  sleep 1
done

exec npm run worker
