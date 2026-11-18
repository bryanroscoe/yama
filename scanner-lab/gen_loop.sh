#!/bin/sh
# Generate K=2 crops for every downloaded card, again and again until the download has finished.
# Run from the work directory, beside download.py: sh <lab>/gen_loop.sh
lab="$(cd "$(dirname "$0")" && pwd)"
python="${PYTHON:-python3}"
while pgrep -f "download.py" > /dev/null; do
  K=2 "$python" -u "$lab/gen.py"
  sleep 20
done
K=2 "$python" -u "$lab/gen.py"
echo "gen loop finished: $(ls data/crops | wc -l) crops"
