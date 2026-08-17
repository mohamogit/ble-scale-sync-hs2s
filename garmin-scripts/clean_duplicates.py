"""
Clean Garmin 08-16 duplicate 91.39 loop (63 -> 1).
Usage: /home/pi/ble-scale-sync-hs2s/.venv/bin/python garmin-scripts/clean_duplicates.py --dry-run
       /home/pi/ble-scale-sync-hs2s/.venv/bin/python garmin-scripts/clean_duplicates.py --yes
"""
import argparse, os, sys
from pathlib import Path
from dotenv import load_dotenv
from garminconnect import Garmin

PROJECT_ROOT = Path(__file__).resolve().parent.parent
load_dotenv(PROJECT_ROOT / ".env")

def get_client(token_dir):
    g = Garmin()
    g.login(str(Path(token_dir).expanduser()))
    return g

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--token-dir", default="./garmin-tokens")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--yes", action="store_true")
    ap.add_argument("--date", default="2026-08-16", help="calendarDate to dedup")
    args = ap.parse_args()
    g = get_client(args.token_dir)
    # Use garth weight API via garminconnect's internal
    import datetime
    start = "2026-07-27"
    end = "2026-08-16"
    data = g.get_body_composition(start, end)
    # Also fetch weigh_ins for detail
    w = g.get_weigh_ins(start, end)
    day = [x for x in w.get("dailyWeightSummaries",[]) if x["summaryDate"]==args.date]
    if not day:
        print(f"No entries for {args.date}")
        return
    metrics = day[0]["allWeightMetrics"]
    print(f"{args.date}: {len(metrics)} entries")
    for m in metrics[:5]:
        print(f"  {m['samplePk']} {m['weight']} {m['date']}")
    # Group by weight±0.05, keep earliest
    seen = {}
    to_delete = []
    for m in sorted(metrics, key=lambda x: x["date"]):
        key = round(m["weight"]/50)  # 50g bucket
        # more precise: exact weight
        k = int(m["weight"])
        if k not in seen:
            seen[k]=m
        else:
            # same weight bucket -> duplicate, mark for deletion (keep first)
            if abs(m["weight"]-seen[k]["weight"])<60:
                to_delete.append(m)
            else:
                seen[k]=m
    print(f"Would delete {len(to_delete)} duplicates, keep {len(metrics)-len(to_delete)}")
    if args.dry_run:
        print("dry-run, not deleting")
        return
    if not args.yes:
        print("Add --yes to actually delete")
        return
    for m in to_delete:
        pk = m["samplePk"]
        try:
            # garminconnect delete: use g.delete_weigh_in ?
            # Fallback via garth API
            g.delete_body_composition(pk) if hasattr(g,"delete_body_composition") else g.garth.request("DELETE", f"/weight-service/weight/{pk}", api=True)
            print(f"deleted {pk} {m['weight']}")
        except Exception as e:
            print(f"failed {pk}: {e}")
    print("done")

if __name__=="__main__":
    main()
