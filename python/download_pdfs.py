#!/usr/bin/env python3
"""
MotoGP Analysis PDF Downloader
================================
Downloads "Chronological Analysis of Performances" PDFs from resources.motogp.com
and organises them as:

    <BASE_DIR>/<TRACK>/<YEAR>/<CODE>_MGP_<SESSION>.pdf

Usage:
    python3.13 download_pdfs.py                   # download everything from 2016
    python3.13 download_pdfs.py --dry-run         # preview without downloading
    python3.13 download_pdfs.py --from-year 2023  # only recent seasons
    python3.13 download_pdfs.py --gp CZE          # single GP
    python3.13 download_pdfs.py --workers 16      # more parallel downloads
    python3.13 download_pdfs.py --verbose         # show all API responses
"""

import sys
import re
import time
import unicodedata
import argparse
import threading
from datetime import date, datetime
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed

try:
    import requests
except ImportError:
    print("Installing 'requests' library...")
    import subprocess, os
    subprocess.check_call([sys.executable, "-m", "pip", "install", "--break-system-packages", "requests"])
    os.execv(sys.executable, [sys.executable] + sys.argv)
    sys.exit(0)

# ── Config ─────────────────────────────────────────────────────────────────────
BASE_API    = "https://api.motogp.pulselive.com/motogp/v1"
BASE_DIR    = Path(__file__).parent.parent
HEADERS     = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
    "Accept": "application/json",
}
API_DELAY   = 0.3   # seconds between API calls (shared across threads)

VERBOSE     = False
_print_lock = threading.Lock()
_api_lock   = threading.Lock()
_last_api   = 0.0  # timestamp of last API call


def log(*args, **kwargs) -> None:
    with _print_lock:
        print(*args, **kwargs)


# ── API helpers ────────────────────────────────────────────────────────────────

def api_get(path: str, params: dict | None = None) -> list | dict | None:
    global _last_api
    url = f"{BASE_API}{path}"
    if VERBOSE:
        log(f"  [api] GET {path} {params or ''}")

    # Rate-limit API calls globally across all threads
    with _api_lock:
        wait = API_DELAY - (time.monotonic() - _last_api)
        if wait > 0:
            time.sleep(wait)
        _last_api = time.monotonic()

    for attempt in range(3):
        try:
            r = requests.get(url, params=params, headers=HEADERS, timeout=20)
            if r.status_code == 200:
                return r.json()
            if r.status_code == 404:
                return None
            time.sleep(2 ** attempt)
        except requests.RequestException as e:
            log(f"  [warn] {e} — retrying ({attempt + 1}/3)")
            time.sleep(2 ** attempt)
    return None


def get_seasons() -> list[dict]:
    data = api_get("/results/seasons")
    return sorted(data or [], key=lambda s: s["year"])


def get_motogp_category_uuid(season_uuid: str) -> str | None:
    cats = api_get("/results/categories", {"seasonUuid": season_uuid})
    for c in cats or []:
        if c.get("name", "").startswith("MotoGP"):
            return c["id"]
    return None


def get_events(season_uuid: str) -> list[dict]:
    return api_get("/results/events", {"seasonUuid": season_uuid}) or []


def get_sessions(event_uuid: str, category_uuid: str) -> list[dict]:
    return api_get("/results/sessions", {
        "eventUuid": event_uuid,
        "categoryUuid": category_uuid,
    }) or []


def get_classification_file(session_uuid: str, season_year: int) -> str | None:
    data = api_get(f"/results/session/{session_uuid}/classification", {
        "seasonYear": season_year,
    })
    if isinstance(data, dict):
        return data.get("file")
    return None


# ── Path helpers ───────────────────────────────────────────────────────────────

TRACK_CANONICAL: dict[str, str] = {
    "CREDITAS_AUTODROM_BRNO": "AUTOMOTODROM_BRNO",
}

def track_folder_name(event: dict) -> str:
    circuit = event.get("circuit") or {}
    name = (
        circuit.get("name")
        or circuit.get("place")
        or event.get("name")
        or event.get("short_name")
        or "UNKNOWN"
    )
    name = unicodedata.normalize("NFKD", name)
    name = "".join(c for c in name if not unicodedata.combining(c))
    name = re.sub(r"[^\w\s-]", "", name).strip()
    name = re.sub(r"[\s\-]+", "_", name).upper()
    return TRACK_CANONICAL.get(name, name)


def session_code_from_url(url: str) -> str | None:
    m = re.search(r"/MotoGP/([^/]+)/(?:Classification|Analysis)\.pdf", url, re.IGNORECASE)
    return m.group(1) if m else None


# ── Download ───────────────────────────────────────────────────────────────────

def download_one(task: dict) -> dict:
    """Download a single PDF. Returns a result dict with status and label."""
    url    = task["url"]
    dest   = task["dest"]
    label  = task["label"]

    if dest.exists():
        return {"label": label, "status": "skip"}

    dest.parent.mkdir(parents=True, exist_ok=True)
    try:
        r = requests.get(url, headers=HEADERS, timeout=30)

        if r.status_code != 200:
            return {"label": label, "status": "fail", "reason": f"HTTP {r.status_code}"}

        if r.content[:4] != b"%PDF":
            return {"label": label, "status": "fail", "reason": f"not a PDF ({r.content[:12]!r})"}

        dest.write_bytes(r.content)
        size_kb = len(r.content) // 1024
        return {"label": label, "status": "ok", "size_kb": size_kb}

    except requests.RequestException as e:
        return {"label": label, "status": "fail", "reason": str(e)}


# ── Build task list (sequential API crawl) ─────────────────────────────────────

def build_download_tasks(args) -> list[dict]:
    """Walk the API and return a list of download tasks — no downloading yet."""
    seasons = get_seasons()
    if not seasons:
        print("ERROR: Could not reach MotoGP API.")
        return []

    tasks: list[dict] = []

    for season in seasons:
        year = season["year"]
        if year < args.from_year or year > args.to_year:
            continue

        print(f"\n{'=' * 60}  {year}")

        motogp_uuid = get_motogp_category_uuid(season["id"])
        if not motogp_uuid:
            print(f"  [warn] No MotoGP category for {year}")
            continue

        events = get_events(season["id"])
        if not events:
            print(f"  [warn] No events for {year}")
            continue

        print(f"  {len(events)} events")

        for event in events:
            kind    = event.get("kind", "GP")
            gp_code = (event.get("short_name") or "").upper()
            track   = track_folder_name(event)
            gp_name = event.get("name", gp_code)

            if kind == "TEST" and not args.tests:
                continue
            if not gp_code:
                continue
            if args.gp and gp_code != args.gp.upper():
                continue

            # Skip events that haven't started yet.
            # If the weekend has started, include it — sessions that haven't
            # happened yet will simply 404 and be counted as failed (harmless).
            date_start = event.get("date_start") or event.get("dateStart") or ""
            status     = (event.get("status") or "").lower()
            today      = date.today()

            def _parse_date(s: str) -> date | None:
                try:
                    return datetime.fromisoformat(s.replace("Z", "+00:00")).date()
                except (ValueError, AttributeError, TypeError):
                    return None

            start_date = _parse_date(date_start)

            if start_date and start_date > today:
                if VERBOSE:
                    print(f"  [{gp_code}] not started yet ({start_date}), skipping")
                continue

            # Status fallback for events with no date
            if not start_date and status in ("upcoming", "scheduled", "tbc"):
                if VERBOSE:
                    print(f"  [{gp_code}] status={status!r}, skipping")
                continue

            # No date info at all — attempt anyway, 404s are harmless

            sessions = get_sessions(event["id"], motogp_uuid)
            if not sessions:
                continue

            event_tasks = 0
            for session in sessions:
                session_uuid = session.get("id")
                session_type = session.get("type", "")
                session_num  = session.get("number", 1)

                if args.no_race and session_type in ("RAC", "RACE"):
                    continue

                clf_url = get_classification_file(session_uuid, year)

                if not clf_url:
                    type_map = {
                        "P":    f"FP{session_num}",
                        "FP":   f"FP{session_num}",
                        "Q":    f"Q{session_num}",
                        "RAC":  "RAC",
                        "RACE": "RAC",
                        "SPR":  "SPR",
                        "WUP":  "WUP",
                        "PR":   "PR",
                    }
                    code    = type_map.get(session_type, session_type)
                    clf_url = f"https://resources.motogp.com/files/results/{year}/{gp_code}/MotoGP/{code}/Classification.pdf"

                session_folder = session_code_from_url(clf_url)
                if not session_folder:
                    continue

                analysis_url = clf_url.replace("Classification.pdf", "Analysis.pdf")
                filename     = f"{gp_code}_MGP_{session_folder}.pdf"
                dest         = BASE_DIR / track / str(year) / filename
                label        = f"{year} [{gp_code}] {session_folder}"

                tasks.append({
                    "url":   analysis_url,
                    "dest":  dest,
                    "label": label,
                    "gp":    gp_name,
                    "track": track,
                    "year":  year,
                })
                event_tasks += 1

            if event_tasks:
                print(f"  [{gp_code}] {gp_name}  →  {event_tasks} sessions queued")

    return tasks


# ── Main ───────────────────────────────────────────────────────────────────────

def main() -> None:
    global VERBOSE

    parser = argparse.ArgumentParser(description="Download MotoGP Analysis PDFs")
    parser.add_argument("--from-year", type=int, default=2016)
    parser.add_argument("--to-year",   type=int, default=9999)
    parser.add_argument("--gp",        type=str, default=None,
                        help="Only this GP code, e.g. CZE")
    parser.add_argument("--dry-run",   action="store_true",
                        help="Show what would be downloaded without saving")
    parser.add_argument("--no-race",   action="store_true")
    parser.add_argument("--tests",     action="store_true",
                        help="Include pre-season tests")
    parser.add_argument("--workers",   type=int, default=8,
                        help="Parallel download threads (default: 8)")
    parser.add_argument("--verbose",   action="store_true")
    args   = parser.parse_args()
    VERBOSE = args.verbose

    print("MotoGP PDF Downloader")
    print(f"Saving to : {BASE_DIR}")
    print(f"Years     : {args.from_year} – {args.to_year}")
    print(f"Workers   : {args.workers}")
    if args.dry_run:
        print("Mode      : DRY RUN")

    # ── Phase 1: crawl API sequentially to build task list ──────────────────
    print("\nCrawling API…")
    tasks = build_download_tasks(args)

    if not tasks:
        print("\nNothing to do.")
        return

    already   = [t for t in tasks if t["dest"].exists()]
    to_fetch  = [t for t in tasks if not t["dest"].exists()]

    print(f"\n{'=' * 60}")
    print(f"Total sessions : {len(tasks)}")
    print(f"Already have   : {len(already)}")
    print(f"To download    : {len(to_fetch)}")

    if args.dry_run:
        print("\nDry-run — files that would be downloaded:")
        for t in to_fetch:
            print(f"  {t['label']:40s}  →  {t['dest'].relative_to(BASE_DIR)}")
        return

    if not to_fetch:
        print("\nAll files already downloaded.")
        return

    # ── Phase 2: parallel downloads ──────────────────────────────────────────
    print(f"\nDownloading {len(to_fetch)} files with {args.workers} workers…\n")

    downloaded = 0
    failed     = 0
    total      = len(to_fetch)

    with ThreadPoolExecutor(max_workers=args.workers) as executor:
        futures = {executor.submit(download_one, t): t for t in to_fetch}
        for future in as_completed(futures):
            result = future.result()
            label  = result["label"]

            match result["status"]:
                case "ok":
                    downloaded += 1
                    log(f"  [✓] [{downloaded}/{total}]  {label}  ({result['size_kb']} KB)")
                case "skip":
                    pass  # already existed, counted above
                case "fail":
                    failed += 1
                    log(f"  [✗] {label}  — {result.get('reason', '?')}")

    print(f"\n{'=' * 60}")
    print(f"Downloaded : {downloaded}")
    print(f"Skipped    : {len(already)}")
    print(f"Failed     : {failed}")
    if downloaded > 0:
        print(f'\nRun parser: python3.13 "{BASE_DIR}/python/motogp_parser.py"')


if __name__ == "__main__":
    main()
