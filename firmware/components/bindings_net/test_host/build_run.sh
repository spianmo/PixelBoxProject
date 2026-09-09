#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
binary=$(mktemp /tmp/pixelbox-ws-frame-test.XXXXXX)
trap 'rm -f "$binary"' EXIT
c++ -std=c++17 -Wall -Wextra -Werror -Istubs -I../src \
  ../src/ws_frame_transport.cpp ws_frame_transport_test.cpp -o "$binary"
"$binary"
