#!/bin/sh
# Download the picked cards (download.py) and generate K=2 crops for every card downloaded so far,
# again and again until the download has finished, then once more.
# Run from the work directory: sh <lab>/gen_loop.sh
lab="$(cd "$(dirname "$0")" && pwd)"
python="${PYTHON:-python3}"
"$python" -u "$lab/download.py" &
download=$!
while kill -0 "$download" 2> /dev/null; do
  K=2 "$python" -u "$lab/gen.py"
  sleep 20
done
wait "$download" || echo "download.py failed; the crops cover only the cards it fetched" >&2
K=2 "$python" -u "$lab/gen.py"
echo "gen loop finished: $(ls data/crops | wc -l) crops"
