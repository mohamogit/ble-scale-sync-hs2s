import argparse
import json
import os
import sys
from pathlib import Path

from dotenv import load_dotenv
from garminconnect import Garmin

PROJECT_ROOT = Path(__file__).resolve().parent.parent
load_dotenv(PROJECT_ROOT / ".env")


def log(msg):
    print(msg, file=sys.stderr)


def get_token_dir(token_dir=None):
    if token_dir:
        return str(Path(token_dir).expanduser())
    custom = os.environ.get("TOKEN_DIR", "").strip()
    if custom:
        return str(Path(custom).expanduser())
    new = Path.home() / ".garmin_tokens"
    old = Path.home() / ".garmin_renpho_tokens"
    if old.is_dir() and not new.is_dir():
        return str(old)
    return str(new)


def has_legacy_only_tokens(token_dir):
    """True when directory contains pre-0.3 garth tokens but no new-format token.

    Pre-0.3 garminconnect persisted oauth1_token.json + oauth2_token.json via garth.
    garminconnect 0.3.x uses a different format (single garmin_tokens.json).
    """
    path = Path(token_dir)
    if not path.is_dir():
        return False
    legacy = list(path.glob("oauth*_token.json"))
    new_token = path / "garmin_tokens.json"
    return bool(legacy) and not new_token.exists()


def get_garmin_client(token_dir=None, email=None, password=None):
    # Fresh login with email/password (preferred, stateless, no token expiry)
    if email and password:
        log(f"[Garmin] Fresh login as {email}")
        garmin = Garmin(email, password)
        garmin.login()
        log("[Garmin] Authenticated (fresh login).")
        return garmin

    token_dir = get_token_dir(token_dir)
    log(f"[Garmin] Loading tokens from {token_dir}")

    if not os.path.isdir(token_dir):
        raise RuntimeError(
            f"Token directory not found: {token_dir}. "
            "Run 'npm run setup-garmin' first or provide email/password in config."
        )

    try:
        import garminconnect
        ver = getattr(garminconnect, "__version__", "0.2.8")
        is_legacy = has_legacy_only_tokens(token_dir)
        if is_legacy and ver.startswith("0.3"):
            raise RuntimeError(
                "Token format changed in garminconnect 0.3.x. "
                "Run 'npm run setup-garmin' to re-authenticate."
            )
    except Exception:
        pass

    garmin = Garmin()
    garmin.login(token_dir)
    log("[Garmin] Authenticated (token).")
    return garmin


def upload(payload, token_dir=None, email=None, password=None):
    garmin = get_garmin_client(token_dir, email, password)

    # ISO 8601 string when present; the orchestrator sets it for historical
    # readings replayed from a scale's offline cache (#164). When absent the
    # garminconnect library defaults to the current time.
    ts = payload.get("timestamp")
    if ts:
        log(f"[Garmin] Back-dating measurement to {ts}")

    log("[Garmin] Uploading body composition...")
    if hasattr(garmin, "add_body_composition"):
        garmin.add_body_composition(
            timestamp=ts,
            weight=payload["weight"],
            percent_fat=payload["bodyFatPercent"],
            percent_hydration=payload["waterPercent"],
            bone_mass=payload["boneMass"],
            muscle_mass=payload["muscleMass"],
            visceral_fat_rating=payload["visceralFat"],
            physique_rating=payload["physiqueRating"],
            metabolic_age=payload["metabolicAge"],
            bmi=payload["bmi"],
        )
    else:
        # 0.2.8 fallback: weight-only via add_weigh_in (body comp not supported)
        log("[Garmin] add_body_composition not available (0.2.8), falling back to weigh-in")
        garmin.add_weigh_in(payload["weight"], timestamp=ts or "")

    log("[Garmin] Upload successful!")
    return {
        "weight": payload["weight"],
        "bodyFatPercent": payload["bodyFatPercent"],
        "muscleMass": payload["muscleMass"],
        "visceralFat": payload["visceralFat"],
        "physiqueRating": payload["physiqueRating"],
    }


def parse_args():
    parser = argparse.ArgumentParser(
        description="Upload body composition to Garmin Connect"
    )
    parser.add_argument("--token-dir", help="Directory containing auth tokens (or set TOKEN_DIR env var, default: ~/.garmin_tokens)")
    parser.add_argument("--email", help="Garmin email for fresh login (preferred)")
    parser.add_argument("--password", help="Garmin password for fresh login")
    return parser.parse_args()


def main():
    args = parse_args()

    try:
        raw = sys.stdin.read()
        payload = json.loads(raw)
    except (json.JSONDecodeError, ValueError) as e:
        log(f"[Garmin] Invalid JSON input: {e}")
        print(json.dumps({"success": False, "error": f"Invalid JSON input: {e}"}))
        sys.exit(1)

    try:
        data = upload(payload, args.token_dir, args.email, args.password)
        print(json.dumps({"success": True, "data": data}))
        sys.exit(0)
    except Exception as e:
        log(f"[Garmin] Error: {e}")
        print(json.dumps({"success": False, "error": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
