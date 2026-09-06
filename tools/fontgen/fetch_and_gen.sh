#!/usr/bin/env bash
# The sources are already versioned in the simulator; no release download needed.
set -euo pipefail
cd "$(dirname "$0")"
python3 regenerate.py
python3 check_fonts.py
