#!/usr/bin/env python3
"""Convert a verified source-recovery folder into a deterministic yama-dataset/1 gzip.

No network requests. No owner, credentials, local filesystem paths, images, article prose or
private user/deck data enter the upload. Source bytes remain in the original recovery folder.
"""
import argparse
import datetime as dt
import gzip
import hashlib
import json
from pathlib import Path


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode()


def local_file(root, relative):
    file = root / relative
    if file.is_symlink() or not file.resolve().is_relative_to(root.resolve()) or not file.is_file():
        raise ValueError("source file is missing, a symlink or outside the recovery folder")
    return file


def timestamp(value):
    if not value:
        return None
    date = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    if date.tzinfo is None:
        raise ValueError("source timestamps must include a time zone")
    return date.astimezone(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def capture(value):
    return dt.datetime.strptime(value, "%Y%m%d%H%M%S").replace(tzinfo=dt.timezone.utc).isoformat().replace("+00:00", "Z") if value else None


def prepare(root):
    manifest = json.loads(local_file(root, "manifest.json").read_bytes())
    if manifest.get("schema") != "yama-source-recovery/1":
        raise ValueError("expected yama-source-recovery/1")
    sources = {}
    recovered = [s for s in manifest["sources"] if s.get("status") == "recovered"]
    for source in recovered:
        payload = gzip.decompress(local_file(root, source["file"]).read_bytes())
        if hashlib.sha256(payload).hexdigest() != source["sha256"]:
            raise ValueError("source content hash mismatch")
        entry = {"sha256": source["sha256"], "url": source["retrieval_url"],
                 "retrieved_at": timestamp(source.get("retrieved_at")),
                 "source_as_of": timestamp(source.get("source_as_of")), "captured_at": capture(source.get("capture_timestamp")),
                 "flags": ["partial_archive_capture"] if source.get("archive_truncated") else [],
                 "transformation": source.get("transformation"), "original_response_sha256": source.get("original_response_sha256")}
        sources.setdefault(entry["sha256"], entry)
    for source in manifest.get("local_snapshots", {}).values():
        payload = local_file(root, source["file"]).read_bytes()
        if hashlib.sha256(payload).hexdigest() != source["sha256"]:
            raise ValueError("local snapshot content hash mismatch")
        doc = json.loads(payload)
        sources.setdefault(source["sha256"], {"sha256": source["sha256"], "url": doc.get("source"),
            "retrieved_at": None, "source_as_of": timestamp(doc.get("site_updated")), "captured_at": None,
            "flags": ["previously_saved_source_snapshot"], "transformation": None, "original_response_sha256": None})
    records = []

    def add(ident, kind, entity, refs, data):
        if not refs or any(ref not in sources for ref in refs):
            raise ValueError("record references an unknown source document")
        if len(canonical(data)) > 2 << 20:
            raise ValueError("record exceeds 2 MiB")
        records.append({"id": ident, "kind": kind, "entity": entity, "sources": sorted(set(refs)), "data": data})

    for line in local_file(root, "observations.jsonl").read_text().splitlines():
        data = json.loads(line)
        period = data["observation_period"]
        if period.get("source_as_of"):
            period["source_as_of"] = timestamp(period["source_as_of"])
        if period["kind"] == "calendar_month" and data.get("selection") == "monthly_top_100_by_play_count":
            data["source_cohort_url"] = data["cohort"]
            data["cohort"] = "playgroup:monthly:top100-by-plays"
        add(data["id"], "performance", data["entity_id"], data["source_documents"], data)
    for line in local_file(root, "weekly-activity.jsonl").read_text().splitlines():
        data = json.loads(line)
        add("weekly:" + data["entity_id"].split(":")[-1] + ":" + data["week"], "weekly_activity", data["entity_id"], [data["source_sha256"]], data)
    catalog = next(s for s in recovered if s["kind"] == "current_commander_aggregate_catalog")
    for line in local_file(root, "commander-catalog.jsonl").read_text().splitlines():
        data = json.loads(line)
        add("commander:" + str(data["id"]), "commander", "playgroup:commander:" + str(data["id"]), [catalog["sha256"]], data)
    for source in recovered:
        if source["kind"] == "public_commander_history_aggregate":
            data = json.loads(gzip.decompress(local_file(root, source["file"]).read_bytes()))
            if not set(data) <= {"id", "name", "stats", "graphs", "cached_elo", "global_rank"}:
                raise ValueError("unexpected fields in sanitized commander history")
            add("history:" + str(data["id"]), "commander_history", "playgroup:commander:" + str(data["id"]), [source["sha256"]], data)
        if source["kind"] == "current_archetype_reference":
            slug = source["source_url"].rstrip("/").split("/")[-1]
            add("archetype:" + slug, "archetype", "playgroup:archetype:" + slug, [source["sha256"]],
                {"name": slug.replace("-", " "), "source_url": source["source_url"], "reference_only": True,
                 "note": "Source-defined strategy/style reference; no hard card-overlap cutoff or deck assignment."})
    seen_tables = set()
    for source in recovered:
        if not source.get("parsed_page") or source["sha256"] in seen_tables:
            continue
        seen_tables.add(source["sha256"])
        page = json.loads(local_file(root, source["parsed_page"]).read_bytes())
        for index, table in enumerate(page.get("tables", [])):
            for offset in range(0, len(table), 100):
                add(f"table:{source['sha256']}:{index}:{offset}", "source_table", "source:" + source["sha256"], [source["sha256"]],
                    {"name": "Extracted source table", "source_url": source["source_url"], "table_index": index,
                     "row_offset": offset, "rows": table[offset:offset + 100], "metric_interpretation": "Preserved source structure; no automatic performance interpretation."})
    if len({r["id"] for r in records}) != len(records):
        raise ValueError("duplicate record ids")
    return {"schema": "yama-dataset/1", "id": "playgroup-history-20261028", "title": "Playgroup historical Commander evidence",
        "generated_at": timestamp(manifest["created_at"]),
        "source": {"name": "Playgroup.gg", "url": "https://playgroup.gg/research", "attribution": "Playgroup.gg / Arcane Digital B.V.; archived copies from Internet Archive and Common Crawl", "license": "CC BY 4.0 for aggregated anonymized statistics: https://playgroup.gg/legal"},
        "method": "Recovered dated aggregate snapshots, published monthly top-100 commander observations, complete current ranking windows, commander catalog and sanitized history. No independent games inferred from overlapping snapshots or ELO sequences. Theme/style references remain separate from card overlap.",
        "coverage": json.loads(local_file(root, "coverage.json").read_bytes()), "sources": sorted(sources.values(), key=lambda s: s["sha256"]),
        "records": sorted(records, key=lambda r: r["id"])}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("recovery_folder", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    doc = prepare(args.recovery_folder)
    raw = canonical(doc)
    if len(raw) > 128 << 20:
        raise ValueError("decoded bundle exceeds 128 MiB")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_bytes(gzip.compress(raw, mtime=0))
    counts = {}
    for record in doc["records"]:
        counts[record["kind"]] = counts.get(record["kind"], 0) + 1
    print(json.dumps({"id": doc["id"], "records": counts, "source_documents": len(doc["sources"]), "decoded_bytes": len(raw),
                      "gzip_bytes": args.output.stat().st_size, "content_hash": hashlib.sha256(raw).hexdigest()}, sort_keys=True))


if __name__ == "__main__":
    main()
