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
    # token_dir may be relative; mimic garmin_upload.py logic
    token_dir = str(Path(token_dir).expanduser())
    if not Path(token_dir).is_absolute():
        token_dir = str((PROJECT_ROOT / token_dir).resolve())
    # Try token first, fallback to email/password from config.yaml if needed
    try:
        g = Garmin()
        g.login(token_dir)
        print(f"[Garmin] token login ok: {token_dir}")
        return g
    except Exception as e:
        print(f"[Garmin] token login failed: {e}", file=sys.stderr)
        # fallback: read config.yaml for email/password
        try:
            import yaml
            cfg = yaml.safe_load(open(PROJECT_ROOT / "config.yaml"))
            u = cfg["users"][0]["exporters"][0]
            email = u.get("email"); pwd = u.get("password")
            if email and pwd:
                print(f"[Garmin] trying fresh login as {email}", file=sys.stderr)
                g = Garmin(email, pwd)
                g.login(token_dir)
                return g
        except Exception as e2:
            print(f"fresh login failed: {e2}", file=sys.stderr)
        raise

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
        cdate = m.get("calendarDate") or args.date
        try:
            g.delete_weigh_in(str(pk), cdate)
            print(f"deleted {pk} {m['weight']} {cdate}")
        except Exception as e:
            print(f"failed {pk}: {e}")
    print("done")

if __name__=="__main__":
    main()
