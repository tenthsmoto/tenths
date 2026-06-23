#!/usr/bin/env python3
"""
MotoGP PDF Parser
Extracts rider and lap data from MotoGP timing PDFs (Chronological Analysis sheets).
Outputs per-session JSON files and a master index under data/.

Usage:
    python3.13 motogp_parser.py                  # Scan folder, process new PDFs
    python3.13 motogp_parser.py --force          # Reprocess all PDFs
    python3.13 motogp_parser.py path/to/file.pdf # Process one specific PDF
"""

import pdfplumber
import re
import os
import sys
import json
from pathlib import Path
from datetime import datetime, timezone
from concurrent.futures import ProcessPoolExecutor, as_completed

# ── Paths ──────────────────────────────────────────────────────────────────────
BASE_DIR = Path(__file__).parent.parent
LOG_PATH = BASE_DIR / ".processed_files.json"
JSON_DIR = BASE_DIR / "docs" / "data"

# ── Session type mapping ────────────────────────────────────────────────────────
SESSION_MAP = {
    "FREE PRACTICE NR. 1": "FP1",
    "FREE PRACTICE NR. 2": "FP2",
    "FREE PRACTICE NR. 3": "FP3",
    "FREE PRACTICE": "FP",
    "PRACTICE": "FP",
    "QUALIFYING PRACTICE": "QP",
    "QUALIFYING 1": "Q1",
    "QUALIFYING 2": "Q2",
    "SPRINT RACE": "SPR",
    "GRAND PRIX": "RACE",
    "WARM UP": "WUP",
}

CLASS_MAP = {
    "MGP": "MotoGP",
    "M2":  "Moto2",
    "M3":  "Moto3",
}

# ── Track folder aliases → canonical name ──────────────────────────────────────
# When a circuit is renamed/rebranded, map the old/alternate folder name to the
# canonical one so the index doesn't contain duplicate sessions.
TRACK_CANONICAL: dict[str, str] = {
    "CREDITAS_AUTODROM_BRNO": "AUTOMOTODROM_BRNO",
}

# ── Lap line regex ─────────────────────────────────────────────────────────────
# Handles all observed formats:
#   "14 1'53.523 34.786 21.869 27.108 29.760 318.5"       normal
#   "2 1'57.195 * 36.548 22.856 27.716* 30.075 * 313.9"   cancelled (* on time)
#   "3 1'59.611 * 37.912 22.802 28.217 30.680 *"          cancelled, no speed
#   "10 2'08.492 P 36.903 23.165 28.450 39.974 316.7"     pit-in (P on time)
#   "1 2'12.559 37.693 23.101 28.184 30.445"              no speed (first lap)
LAP_LINE_RE = re.compile(
    r"^\s*(\d+)\s+"            # group 1: lap number
    r"(\d+'\d+\.\d+)\s*"       # group 2: lap time like 1'53.503
    r"([P\*])?\s*"             # group 3: optional flag  P=pit-in  *=cancelled
    r"([\d\.]+)\s*\*?\s+"      # group 4: T1 (optional trailing *)
    r"([\d\.]+)\s*\*?\s+"      # group 5: T2
    r"([\d\.]+)\s*\*?\s+"      # group 6: T3
    r"([\d\.]+)(?:\s*\*)?"     # group 7: T4 (optional space+* or attached *)
    r"(?:\s+([\d\.]+))?"       # group 8: optional top speed
    r"\s*$"
)

# ── Helpers ────────────────────────────────────────────────────────────────────

def lap_time_to_seconds(t: str) -> float | None:
    """Convert '1'53.303' to 113.303 seconds. Returns None on failure."""
    try:
        t = t.strip()
        if "'" in t:
            m, s = t.split("'")
            return int(m) * 60 + float(s)
        return float(t)
    except Exception:
        return None


def parse_ordinal(s: str) -> int | None:
    """'1st' -> 1, '22nd' -> 22, etc."""
    m = re.match(r'^(\d+)(?:st|nd|rd|th)$', s.strip())
    return int(m.group(1)) if m else None


def extract_session_info(page1_text: str, pdf_path: Path) -> dict:
    """Parse session metadata from page 1 header text and file path."""
    info = {}

    # ── From file path ──────────────────────────────────────────────────────────
    parts = pdf_path.parts
    # Expected: .../COUNTRY/YEAR/CODE_CLASS_SESSION.pdf
    try:
        info["year"]    = int(parts[-2])
        info["country"] = parts[-3].title()
    except Exception:
        info["year"]    = None
        info["country"] = ""

    stem = pdf_path.stem.upper()  # e.g. "CZE_MGP_FP1"
    stem_parts = stem.split("_")
    if len(stem_parts) >= 3:
        info["class"]   = CLASS_MAP.get(stem_parts[1], stem_parts[1])
        info["session"] = stem_parts[2]
    elif len(stem_parts) == 2:
        info["class"]   = CLASS_MAP.get(stem_parts[1], stem_parts[1])
        info["session"] = ""
    else:
        info["class"]   = ""
        info["session"] = ""

    # ── From PDF text ───────────────────────────────────────────────────────────
    # GP name — stop before sector markers (I1/I2/I3), timing flags (Fl/S),
    # digits, or line breaks so we don't capture column-header junk.
    gp_m = re.search(
        r'GRAND PRIX OF\s+([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ\s\-\']+?)(?=\s+(?:[A-Z]\d|Fl\b|S\b)|\s*[\n\r]|\s{3,}|\d|$)',
        page1_text, re.IGNORECASE,
    )
    info["gp"] = gp_m.group(1).strip().title() if gp_m else info["country"]

    # Circuit name — look for known length pattern (e.g. "5048 m.") immediately
    # after the circuit name; keep only short single-line matches.
    circuit_m = re.search(r'^([^\n]{4,60}?)\s+\d[\d,.]+\s*m\.', page1_text, re.MULTILINE)
    info["circuit"] = circuit_m.group(1).strip().title() if circuit_m else ""

    session_long = ""
    for long_name in SESSION_MAP:
        if long_name in page1_text.upper():
            session_long = long_name.title()
            if not info.get("session"):
                info["session"] = SESSION_MAP[long_name]
            break
    info["session_long"] = session_long

    date_m = re.search(
        r'(\w+),\s+(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),\s+'
        r'(\w+ \d{1,2}, \d{4})',
        page1_text, re.IGNORECASE,
    )
    if date_m:
        try:
            info["date"] = datetime.strptime(date_m.group(2), "%B %d, %Y").date().isoformat()
            if not info.get("year"):
                info["year"] = datetime.strptime(date_m.group(2), "%B %d, %Y").year
        except Exception:
            info["date"] = date_m.group(2)
    else:
        info["date"] = ""

    return info


def get_column_crop_text(page, x0: float, x1: float, y0: float, y1: float) -> str:
    """Crop page to bbox and return extracted text."""
    return page.crop((x0, y0, x1, y1)).extract_text() or ""


def find_rider_markers(page) -> list[dict]:
    """
    Find all rider position markers ('1st', '22nd', etc.) on a page.
    Returns list of {position, ordinal, number, x, y}.
    """
    words = page.extract_words(x_tolerance=4, y_tolerance=4)
    ordinal_pat = re.compile(r'^\d+(?:st|nd|rd|th)$')
    number_pat  = re.compile(r'^\d{1,3}$')

    markers = []
    for i, w in enumerate(words):
        if ordinal_pat.match(w["text"]):
            if i + 1 < len(words) and number_pat.match(words[i + 1]["text"]):
                pos_val = parse_ordinal(w["text"])
                markers.append({
                    "position": pos_val,
                    "ordinal":  w["text"],
                    "number":   words[i + 1]["text"],
                    "x":        w["x0"],
                    "y":        w["top"],
                })
    return markers


# ── Parsing functions ──────────────────────────────────────────────────────────

def parse_rider_section(text: str) -> dict:
    """
    Extract rider metadata from section text (may be column-cropped or full-width).
    Returns dict with name, nationality, bike, team, runs, total_laps, full_laps, valid_laps.

    Handles two header formats:
      Modern (2017+): "Marc Marquez HONDA SPA"   — Name BIKE NAT on one line
      Legacy (2016):  "Marc MARQUEZ Repsol Honda Team SPA 3 1'53.093 ..."
                      Firstname LASTNAME TeamName NAT [lap data on same line]
    """
    info = {}

    bikes = ["DUCATI", "YAMAHA", "HONDA", "APRILIA", "KTM", "SUZUKI", "BMW"]

    # ── Modern format: Name BIKE NAT ───────────────────────────────────────────
    modern_pat = re.compile(
        r'^([A-Za-zÀ-ÿ]+(?:[\s\-][A-Za-zÀ-ÿ]+)*)\s+'
        r'(' + "|".join(bikes) + r')\s+'
        r'([A-Z]{2,4})\s*$'
    )

    # ── Legacy format: Firstname LASTNAME TeamName NAT [data...] ───────────────
    # • Last name is in ALL CAPS including accented uppercase (e.g. VIÑALES, HERNÁNDEZ).
    # • Team name may or may not contain a manufacturer keyword.
    # • Nationality code (2-4 uppercase letters) is optional — it may be cropped.
    # • Line may contain leading junk (gap times, ordinal+number) before the name.
    # • Line may continue with lap data after the NAT code.
    # No ^ anchor so the pattern can match anywhere within a line.
    legacy_pat = re.compile(
        r'(?<![A-Za-z])'                              # not preceded by a letter
        r'([A-Z][a-zÀ-ÿ][A-Za-zÀ-ÿ\-]*)'             # first name: Capital + lowercase(s)
        r'\s+([A-ZÀ-ÖØ-Ý]{2,}(?:[\-][A-ZÀ-ÖØ-Ý]+)*)'  # LAST NAME: all uppercase (incl. accented)
        r'\s+(.+?)'                                    # team name (lazy)
        r'(?:\s+([A-Z]{2,4}))?'                        # nationality (optional)
        r'(?=\s+\d+\s+\d+\'|\s*$|\s*\n)'              # lookahead: lap data, EOL, or newline
    )

    # ── Bike inference from team name ──────────────────────────────────────────
    # Order matters: more specific patterns first.
    # Truncated names (e.g. "Yama", "Hond") arise from column-crop PDF extraction.
    TEAM_BIKE_MAP = [
        # Manufacturer names — full and common truncations
        (re.compile(r'\bHONDA\b|\bHond\b',              re.I), "HONDA"),
        (re.compile(r'\bDUCATI\b|\bDucat\b',            re.I), "DUCATI"),
        (re.compile(r'\bYAMAHA\b|\bYamah\b|\bYama\b',   re.I), "YAMAHA"),
        (re.compile(r'\bSUZUKI\b|\bSuzuk\b',            re.I), "SUZUKI"),
        (re.compile(r'\bAPRILIA\b|\bAprili\b',          re.I), "APRILIA"),
        (re.compile(r'\bKTM\b',                          re.I), "KTM"),
        (re.compile(r'\bBMW\b',                          re.I), "BMW"),
        # GASGAS is a KTM satellite brand
        (re.compile(r'\bGASGAS\b|\bGAS GAS\b',          re.I), "KTM"),
        # Ducati satellite teams (no "Ducati" in name)
        (re.compile(r'\bAspar\b|\bAngel Nieto\b',        re.I), "DUCATI"),
        (re.compile(r'\bAvintia\b|\bEsponsorama\b',      re.I), "DUCATI"),
        (re.compile(r'\bPramac\b',                       re.I), "DUCATI"),
        (re.compile(r'\bVR46\b|\bMonney\b|\bMooney\b',  re.I), "DUCATI"),
        (re.compile(r'\bAruba\b',                        re.I), "DUCATI"),
        # Honda satellite teams
        (re.compile(r'\bMarc VDS\b|\bEstrella\b|\bEG 0',re.I), "HONDA"),
        (re.compile(r'\bHRC\b',                          re.I), "HONDA"),
        (re.compile(r'\bLCR\b',                          re.I), "HONDA"),
        # Aprilia satellite / works teams (Gresini post-2021)
        (re.compile(r'\bGresini\b',                      re.I), "APRILIA"),
        (re.compile(r'\bRNF\b|\bWithU\b|\bCryptodata\b',re.I), "APRILIA"),
    ]

    def bike_from_team(team: str) -> str:
        for pat, mfr in TEAM_BIKE_MAP:
            if pat.search(team):
                return mfr
        return ""

    for line in text.splitlines():
        if "name" in info:
            break

        # Try modern pattern first (requires exact format, line must end with NAT)
        nm = modern_pat.match(line.strip())
        if nm:
            info["name"]        = nm.group(1).strip()
            info["bike"]        = nm.group(2)
            info["nationality"] = nm.group(3)
            continue

        # Try legacy pattern (matches anywhere in line, validates via bike keyword)
        lm = legacy_pat.search(line)
        if lm:
            first = lm.group(1).strip()
            last  = lm.group(2).strip().title()
            team  = lm.group(3).strip()
            nat   = (lm.group(4) or "").strip()
            bike  = bike_from_team(team)

            # Accept match if team has 3+ chars and doesn't start with a digit.
            # Bike may be empty for customer teams that don't name manufacturer.
            if len(team) >= 3 and not re.match(r'^\d', team):
                info["name"]        = f"{first} {last}"
                info["nationality"] = nat
                info["team"]        = team
                info["bike"]        = bike

    pos_pat  = re.compile(r'^\d+(?:st|nd|rd|th)\s+\d+\s*$')
    tyre_pat = re.compile(r'(Front|Rear)\s+Tyre')
    lap_pat  = re.compile(r"^\d+\s+\d+'\d+\.\d+")
    run_pat  = re.compile(r'^Run\s*#')
    stat_pat = re.compile(r'^Runs=')

    # Team from line after "Nth NN" (modern format — legacy already set it above)
    if "team" not in info:
        lines = text.splitlines()
        for i, line in enumerate(lines):
            if pos_pat.match(line.strip()) and i + 1 < len(lines):
                team_candidate = lines[i + 1].strip()
                if (team_candidate
                        and not tyre_pat.search(team_candidate)
                        and not lap_pat.match(team_candidate)
                        and not run_pat.match(team_candidate)
                        and not stat_pat.match(team_candidate)
                        and not pos_pat.match(team_candidate)):
                    info["team"] = team_candidate

    # Stats line — Full laps= and Valid laps= are both optional
    # (2016 PDFs: no Valid laps; column-cropped text may cut off Full laps digit)
    runs_m = re.search(
        r'Runs=(\d+)\s+Total laps=(\d+)'
        r'(?:\s+Full laps=(\d+))?'
        r'(?:\s+Valid laps=(\d+))?',
        text,
    )
    if runs_m:
        info["runs"]       = int(runs_m.group(1))
        info["total_laps"] = int(runs_m.group(2))
        info["full_laps"]  = int(runs_m.group(3)) if runs_m.group(3) else None
        info["valid_laps"] = int(runs_m.group(4)) if runs_m.group(4) else None

    return info


def _lap_type(flag: str, lap_sec: float | None) -> str:
    """
    Classify a lap into Flying / Out / Pit In / Cancelled.
    > 150 sec (2'30") with no flag = Out (installation / warm-up lap).
    All MotoGP/Moto2/Moto3 flying laps are well under 2'30".
    """
    if flag == "*":
        return "Cancelled"
    if flag == "P":
        return "Pit In"
    if lap_sec is not None and lap_sec > 150:
        return "Out"
    return "Flying"


RACE_SESSIONS = {"RAC", "RACE", "SPR"}


def parse_all_laps(text: str, session: str = "") -> list[dict]:
    """
    Extract all individual laps from combined section text (primary + overflow).

    Uses the same Runs= guard as parse_best_lap:
      - skips everything before the rider's own Runs= line
      - stops when a second Runs= line is seen (next rider's block)

    Run # headers are used when present (modern PDFs). When absent (2016 PDFs),
    run boundaries are inferred: any lap whose time > 4 minutes is treated as a
    gap lap (inter-run transfer) and increments the run counter without being
    recorded as a data lap.

    Returns list of dicts with keys matching the non-context LAP_COLS fields.
    """
    laps = []
    within_rider = False
    runs_seen    = 0
    current_run  = None
    has_run_headers = False   # set True if we see any "Run #" line

    # First pass: check whether Run # headers exist in this block
    for raw_line in text.splitlines():
        if re.match(r'Run\s*#\s*\d+', raw_line.strip()):
            has_run_headers = True
            break

    if not has_run_headers:
        # Legacy mode: auto-assign run numbers and start parsing immediately.
        # The column crop already isolates this rider's section, so we don't
        # need to wait for a Runs= line to know we're in the right block.
        current_run  = 1
        within_rider = True

    # Regex to detect a gap lap in legacy PDFs: lap# followed by a time > 4 min.
    # These have non-standard sector columns (cumulative times with apostrophes)
    # so they won't match LAP_LINE_RE — we detect them separately.
    gap_lap_pat = re.compile(r'^\s*\d+\s+([4-9]|\d{2,})\'\d+\.\d+')

    for raw_line in text.splitlines():
        line = raw_line.strip()

        # Runs= guard.
        # Allows optional leading decimal gap-time prefix (e.g. "2.3 Runs=3 ...")
        # that appears in right-column riders, but does NOT match "Runs=" embedded
        # mid-line (which would cause false second-hit and early break).
        if re.match(r'^\s*(?:[\d.]+\s+)?Runs=\d+', line):
            runs_seen += 1
            if runs_seen == 1:
                within_rider = True
            else:
                break   # entered next rider's block
            continue

        # Run # header (modern PDFs and race format).
        # In race PDFs there is no Runs= stats line, so the first "Run # N"
        # is what signals we've entered the rider's lap block.
        rm = re.match(r'Run\s*#\s*(\d+)', line)
        if rm:
            current_run = int(rm.group(1))
            if not within_rider:
                within_rider = True   # race format: no Runs= line
            continue

        if not within_rider:
            continue

        # Legacy mode: detect gap laps (inter-run periods) before trying LAP_LINE_RE.
        # A gap lap starts with a lap number followed by a time >= 4 minutes.
        # These mark run boundaries; they are not recorded as data laps.
        if not has_run_headers and gap_lap_pat.match(line):
            current_run = (current_run or 1) + 1
            continue

        # Lap line
        m = LAP_LINE_RE.match(line)
        if not m:
            continue

        lap_num = int(m.group(1))
        lap_str = m.group(2)
        flag    = m.group(3) or ""

        try:
            t1 = float(m.group(4))
            t2 = float(m.group(5))
            t3 = float(m.group(6))
            t4 = float(m.group(7))
        except (TypeError, ValueError):
            continue

        lap_sec = lap_time_to_seconds(lap_str)
        speed   = m.group(8)

        # Race/sprint lap 1 is a standing start — inherently slower than a
        # flying lap but not slow enough to exceed the Out threshold (150s).
        if session.upper() in RACE_SESSIONS and lap_num == 1 and current_run == 1:
            lap_type = "Start"
        else:
            lap_type = _lap_type(flag, lap_sec)

        laps.append({
            "run_num":       current_run,
            "lap_num":       lap_num,
            "lap_time":      lap_str,
            "lap_time_sec":  round(lap_sec, 3) if lap_sec is not None else None,
            "t1": t1, "t2": t2, "t3": t3, "t4": t4,
            "top_speed":     float(speed) if speed else None,
            "lap_type":      lap_type,
        })

    return laps


def parse_best_lap(text: str) -> dict:
    """
    Scan text for the fastest Flying lap.
    Uses the same Runs= guard to ignore stray laps from the previous rider.
    """
    best_sec   = float("inf")
    best_lap   = None
    best_t     = (None, None, None, None)
    best_speed = None

    within_rider = False
    runs_seen    = 0

    # Detect whether this block uses Run # headers (modern) or not (legacy/race 2016)
    has_run_headers = any(
        re.match(r'Run\s*#\s*\d+', l.strip()) for l in text.splitlines()
    )
    if not has_run_headers:
        # Legacy mode: start scanning immediately; column crop isolates this rider
        within_rider = True

    for line in text.splitlines():
        line = line.rstrip()

        # Use re.search so leading prefix (e.g. "2.3 Runs=") on right-column
        # riders doesn't prevent detection
        if re.search(r'Runs=\d+', line):
            runs_seen += 1
            if runs_seen == 1:
                within_rider = True
                continue
            else:
                break

        # Modern race format: no Runs= line; trigger on first Run # header instead
        if re.match(r'Run\s*#\s*(\d+)', line):
            if not within_rider:
                within_rider = True
            continue

        if not within_rider:
            continue

        # Skip cancelled (*) and pit-in (P) laps
        if re.search(r"'\d+\.\d+\s*\*", line):
            continue
        if re.search(r"'\d+\.\d+\s+P\b", line):
            continue

        m = re.match(
            r'^\s*(\d+)\s+'
            r"(\d+'\d+\.\d+)\s+"
            r'([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)'
            r'(?:\s+([\d.]+))?\s*$',
            line,
        )
        if not m:
            continue

        lap_time = m.group(2)
        secs = lap_time_to_seconds(lap_time)
        if secs is None or secs > 240:   # skip out-laps
            continue

        if secs < best_sec:
            best_sec   = secs
            best_lap   = lap_time
            best_t     = (m.group(3), m.group(4), m.group(5), m.group(6))
            best_speed = m.group(7)

    return {
        "best_lap":     best_lap,
        "best_lap_sec": round(best_sec, 3) if best_lap else None,
        "t1": best_t[0], "t2": best_t[1], "t3": best_t[2], "t4": best_t[3],
        "top_speed": best_speed,
    }


def _extract_header_window(
    full_page_text: str,
    ordinal: str,   # e.g. "1st"
    number: str,    # e.g. "93"
) -> str:
    """
    Locate the ordinal+number marker in the full-width page text and return a
    small window of lines around it (name line above + stats line below).

    Using full-width text avoids column-crop truncation of long 2016-era
    header lines (name + team + NAT that extend past the column midpoint).

    Window is ONLY 1 line before the marker so we don't accidentally include
    an adjacent rider's name from a previous section.
    """
    lines = full_page_text.splitlines()
    marker_pat = re.compile(
        rf'\b{re.escape(ordinal)}\b.*\b{re.escape(number)}\b'
    )
    for i, line in enumerate(lines):
        if marker_pat.search(line):
            start = max(0, i - 1)   # just 1 line before for name detection
            end   = min(len(lines), i + 6)
            return "\n".join(lines[start:end])
    return ""


def parse_pdf(
    pdf_path: Path,
    session_info: dict | None = None,
) -> tuple[list[dict], list[dict], dict]:
    """
    Parse a MotoGP timing PDF.

    Returns (session_rows, lap_rows, session_info):
        session_rows — one dict per rider (matches SESSION_COLS)
        lap_rows     — one dict per individual lap (matches LAP_COLS)
        session_info — metadata extracted from page 1

    Layout note: Each page uses a 2-column (LEFT/RIGHT) × 2-sub-column layout.
    The LAST rider on each half may have continuation laps ("overflow") elsewhere:
        • Last LEFT rider  → RIGHT half of the SAME page  (y = 0 → first right marker)
        • Last RIGHT rider → LEFT half of the NEXT page   (y = 0 → first left marker)
    """
    session_rows: list[dict] = []
    lap_rows:     list[dict] = []

    with pdfplumber.open(pdf_path) as pdf:
        # ── Session info from page 1 ────────────────────────────────────────────
        page1_text = pdf.pages[0].extract_text() or ""
        if session_info is None:
            session_info = extract_session_info(page1_text, pdf_path)

        n_pages = len(pdf.pages)

        # ── Cache full-width page text (used for header extraction) ────────────
        full_page_texts: list[str] = [
            (p.extract_text() or "") for p in pdf.pages
        ]

        # ── Collect all rider markers across all pages ──────────────────────────
        all_markers: list[dict] = []
        for pg_idx, page in enumerate(pdf.pages):
            w = page.width
            for m in find_rider_markers(page):
                m["page_idx"] = pg_idx
                m["side"]     = "left" if m["x"] < w / 2 else "right"
                all_markers.append(m)

        all_markers.sort(key=lambda m: m["position"])

        # ── Group by (page_idx, side) for boundary lookup ───────────────────────
        page_side: dict[tuple, list] = {}
        for m in all_markers:
            key = (m["page_idx"], m["side"])
            page_side.setdefault(key, []).append(m)
        for key in page_side:
            page_side[key].sort(key=lambda m: m["y"])

        # ── Determine overflow zone for the last rider on each half each page ───
        # overflow_for[position] = (overflow_pg_idx, x0, x1, y0, y1)
        overflow_for: dict[int, tuple] = {}

        for pg_idx in range(n_pages):
            page = pdf.pages[pg_idx]
            w    = page.width

            # Last LEFT → RIGHT side of SAME page, capped before first right marker
            left_markers = page_side.get((pg_idx, "left"), [])
            if left_markers:
                last_left = left_markers[-1]
                right_same = page_side.get((pg_idx, "right"), [])
                if right_same:
                    cap_y = right_same[0]["y"] - 20
                    if cap_y > 30:
                        overflow_for[last_left["position"]] = (pg_idx, w / 2, w, 0.0, cap_y)

            # Last RIGHT → LEFT side of NEXT page, capped before first left marker
            right_markers = page_side.get((pg_idx, "right"), [])
            if right_markers and pg_idx + 1 < n_pages:
                last_right = right_markers[-1]
                left_next = page_side.get((pg_idx + 1, "left"), [])
                if left_next:
                    cap_y = left_next[0]["y"] - 20
                    if cap_y > 30:
                        overflow_for[last_right["position"]] = (
                            pg_idx + 1, 0.0, w / 2, 0.0, cap_y
                        )

        # ── Process each rider ──────────────────────────────────────────────────
        for marker in all_markers:
            pg_idx  = marker["page_idx"]
            page    = pdf.pages[pg_idx]
            w       = page.width
            h       = page.height
            is_left = marker["side"] == "left"

            x0 = 0.0   if is_left else w / 2
            x1 = w / 2 if is_left else w

            y_start = max(0.0, marker["y"] - 25)

            same_side = page_side.get((pg_idx, marker["side"]), [])
            later     = [mm for mm in same_side if mm["y"] > marker["y"] + 10]
            y_end     = (later[0]["y"] - 5) if later else h

            section_text = get_column_crop_text(page, x0, x1, y_start, y_end)

            # Overflow text for the last rider on each page half
            overflow_text = ""
            if marker["position"] in overflow_for:
                ov_pg, ov_x0, ov_x1, ov_y0, ov_y1 = overflow_for[marker["position"]]
                overflow_text = get_column_crop_text(
                    pdf.pages[ov_pg], ov_x0, ov_x1, ov_y0, ov_y1
                )

            combined_text = section_text + ("\n" + overflow_text if overflow_text else "")

            # ── Header metadata ─────────────────────────────────────────────────
            # Try the column-cropped section_text first — this works for all
            # modern PDFs (2017+) where the name line fits within the column.
            rider_info = parse_rider_section(section_text)

            # Fallback: if no name was found, the PDF is likely 2016-era where
            # the "Firstname LASTNAME Team NAT" line extends past the column
            # midpoint and gets truncated by the crop. Re-parse from the full-
            # page-width text anchored by the ordinal+number marker.
            if not rider_info.get("name"):
                header_text = _extract_header_window(
                    full_page_texts[pg_idx],
                    marker["ordinal"],
                    marker["number"],
                )
                if header_text:
                    full_info = parse_rider_section(header_text)
                    # Merge: keep any fields section_text already got (e.g. stats
                    # that happened to parse), fill gaps from full-page window.
                    for k, v in full_info.items():
                        if v is not None and rider_info.get(k) is None:
                            rider_info[k] = v

            lap_info   = parse_best_lap(combined_text)
            laps       = parse_all_laps(combined_text, session=session_info.get("session", ""))

            src = str(pdf_path.relative_to(BASE_DIR))

            # ── Session row ─────────────────────────────────────────────────────
            session_rows.append({
                "Year":           session_info.get("year"),
                "GP":             session_info.get("gp", ""),
                "Country":        session_info.get("country", ""),
                "Circuit":        session_info.get("circuit", ""),
                "Session":        session_info.get("session", ""),
                "Session Long":   session_info.get("session_long", ""),
                "Date":           session_info.get("date", ""),
                "Class":          session_info.get("class", ""),
                "Position":       marker["position"],
                "Rider #":        marker["number"],
                "Rider Name":     rider_info.get("name", ""),
                "Nationality":    rider_info.get("nationality", ""),
                "Bike":           rider_info.get("bike", ""),
                "Team":           rider_info.get("team", ""),
                "Runs":           rider_info.get("runs"),
                "Total Laps":     rider_info.get("total_laps"),
                "Full Laps":      rider_info.get("full_laps"),
                "Valid Laps":     rider_info.get("valid_laps"),
                "Best Lap":       lap_info.get("best_lap"),
                "Best Lap (sec)": lap_info.get("best_lap_sec"),
                "T1":             lap_info.get("t1"),
                "T2":             lap_info.get("t2"),
                "T3":             lap_info.get("t3"),
                "T4":             lap_info.get("t4"),
                "Top Speed":      lap_info.get("top_speed"),
                "Source File":    src,
            })

            # ── Lap rows ────────────────────────────────────────────────────────
            ctx = {
                "Year":         session_info.get("year"),
                "GP":           session_info.get("gp", ""),
                "Country":      session_info.get("country", ""),
                "Circuit":      session_info.get("circuit", ""),
                "Session":      session_info.get("session", ""),
                "Session Long": session_info.get("session_long", ""),
                "Date":         session_info.get("date", ""),
                "Class":        session_info.get("class", ""),
                "Position":     marker["position"],
                "Rider #":      marker["number"],
                "Rider Name":   rider_info.get("name", ""),
                "Nationality":  rider_info.get("nationality", ""),
                "Bike":         rider_info.get("bike", ""),
                "Team":         rider_info.get("team", ""),
            }
            for lap in laps:
                lap_rows.append({
                    **ctx,
                    "Run #":          lap["run_num"],
                    "Lap #":          lap["lap_num"],
                    "Lap Time":       lap["lap_time"],
                    "Lap Time (sec)": lap["lap_time_sec"],
                    "T1":             lap["t1"],
                    "T2":             lap["t2"],
                    "T3":             lap["t3"],
                    "T4":             lap["t4"],
                    "Top Speed":      lap["top_speed"],
                    "Lap Type":       lap["lap_type"],
                    "Source File":    src,
                })

    return session_rows, lap_rows, session_info


# ── JSON output ────────────────────────────────────────────────────────────────

def _to_float(val) -> float | None:
    """Safely coerce a value to float, returning None on failure."""
    try:
        return float(val) if val is not None else None
    except (TypeError, ValueError):
        return None


def write_session_json(
    session_rows: list[dict],
    lap_rows: list[dict],
    pdf_path: Path,
    session_info: dict,
) -> Path:
    """
    Write a session JSON file mirroring the PDF path under data/.
    e.g. AUTODROMO_DEL_MUGELLO/2024/ITA_MGP_FP1.pdf
      →  data/AUTODROMO_DEL_MUGELLO/2024/ITA_MGP_FP1.json
    Returns the path of the written file.
    """
    rel       = pdf_path.relative_to(BASE_DIR)
    json_path = JSON_DIR / rel.with_suffix(".json")
    json_path.parent.mkdir(parents=True, exist_ok=True)

    # Group lap rows by rider position
    laps_by_pos: dict[int, list[dict]] = {}
    for lap in lap_rows:
        pos = lap["Position"]
        laps_by_pos.setdefault(pos, []).append(lap)

    # Track folder is the top-level directory (grandparent of the file)
    track_folder = pdf_path.parts[-3] if len(pdf_path.parts) >= 3 else ""

    riders = []
    for s_row in session_rows:
        pos        = s_row["Position"]
        rider_laps = laps_by_pos.get(pos, [])

        riders.append({
            "position":    s_row["Position"],
            "number":      s_row["Rider #"],
            "name":        s_row["Rider Name"],
            "nationality": s_row["Nationality"],
            "bike":        s_row["Bike"],
            "team":        s_row["Team"],
            "summary": {
                "runs":          s_row["Runs"],
                "total_laps":    s_row["Total Laps"],
                "full_laps":     s_row["Full Laps"],
                "valid_laps":    s_row["Valid Laps"],
                "best_lap":      s_row["Best Lap"],
                "best_lap_sec":  _to_float(s_row["Best Lap (sec)"]),
                "best_t1":       _to_float(s_row["T1"]),
                "best_t2":       _to_float(s_row["T2"]),
                "best_t3":       _to_float(s_row["T3"]),
                "best_t4":       _to_float(s_row["T4"]),
                "top_speed_kmh": _to_float(s_row["Top Speed"]),
            },
            "laps": [
                {
                    "run":           lap["Run #"],
                    "lap":           lap["Lap #"],
                    "time":          lap["Lap Time"],
                    "time_sec":      _to_float(lap["Lap Time (sec)"]),
                    "t1":            _to_float(lap["T1"]),
                    "t2":            _to_float(lap["T2"]),
                    "t3":            _to_float(lap["T3"]),
                    "t4":            _to_float(lap["T4"]),
                    "top_speed_kmh": _to_float(lap["Top Speed"]),
                    "type":          lap["Lap Type"],
                }
                for lap in sorted(rider_laps, key=lambda l: (l["Run #"] or 0, l["Lap #"] or 0))
            ],
        })

    doc = {
        "meta": {
            "year":         session_info.get("year"),
            "gp":           session_info.get("gp", ""),
            "gp_name":      session_info.get("gp", ""),
            "circuit":      session_info.get("circuit", ""),
            "track_folder": track_folder,
            "session":      session_info.get("session", ""),
            "session_long": session_info.get("session_long", ""),
            "date":         session_info.get("date", ""),
            "class":        session_info.get("class", ""),
            "source_file":  str(pdf_path.relative_to(BASE_DIR)),
            "parsed_at":    datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        },
        "riders": riders,
    }

    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, indent=2)

    return json_path


def rebuild_index_json() -> None:
    """
    Scan all session JSON files under data/ and write data/index.json.
    The index is a lightweight list of sessions — no lap data — so the
    front-end can render a session picker without loading every file.
    """
    index_path = JSON_DIR / "index.json"
    sessions   = []

    # Build list, normalising track_folder via TRACK_CANONICAL
    seen: dict[tuple, dict] = {}   # (canonical_track, date, session, class) → entry
    for json_file in sorted(JSON_DIR.rglob("*.json")):
        if json_file.name == "index.json":
            continue
        try:
            with open(json_file, encoding="utf-8") as f:
                doc = json.load(f)
            meta = doc.get("meta", {})
            raw_track = meta.get("track_folder", "")
            canonical  = TRACK_CANONICAL.get(raw_track, raw_track)
            entry = {
                "file":         str(json_file.relative_to(JSON_DIR)),
                "year":         meta.get("year"),
                "gp":           meta.get("gp", ""),
                "gp_name":      meta.get("gp_name", ""),
                "circuit":      meta.get("circuit", ""),
                "track_folder": canonical,
                "session":      meta.get("session", ""),
                "session_long": meta.get("session_long", ""),
                "date":         meta.get("date", ""),
                "class":        meta.get("class", ""),
                "rider_count":  len(doc.get("riders", [])),
            }
            key = (canonical, entry["date"], entry["session"], entry["class"])
            # Prefer the entry with more rider data when duplicates exist
            if key not in seen or entry["rider_count"] > seen[key]["rider_count"]:
                seen[key] = entry
        except Exception as e:
            print(f"  [warn] Could not read {json_file.name}: {e}")

    sessions = list(seen.values())
    sessions.sort(key=lambda s: (s.get("date") or "", s.get("session") or ""))

    index = {
        "last_updated":  datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "session_count": len(sessions),
        "sessions":      sessions,
    }

    JSON_DIR.mkdir(parents=True, exist_ok=True)
    with open(index_path, "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, indent=2)

    print(f"  ✓ index.json updated ({len(sessions)} sessions)")


# ── Log management ─────────────────────────────────────────────────────────────

def load_log() -> dict:
    if LOG_PATH.exists():
        with open(LOG_PATH) as f:
            return json.load(f)
    return {}


def save_log(log: dict):
    with open(LOG_PATH, "w") as f:
        json.dump(log, f, indent=2)


# ── Parallel worker ────────────────────────────────────────────────────────────

def _process_one_pdf(pdf_path_str: str) -> dict:
    """
    Top-level worker function — must be picklable (no closures/lambdas).
    Parses one PDF and writes its JSON. Returns a result dict.
    """
    pdf_path = Path(pdf_path_str)
    key      = str(pdf_path.relative_to(BASE_DIR))
    try:
        s_rows, l_rows, session_info = parse_pdf(pdf_path)
        if not s_rows:
            return {"status": "no_riders", "key": key}
        json_path = write_session_json(s_rows, l_rows, pdf_path, session_info)
        return {
            "status":  "ok",
            "key":     key,
            "riders":  len(s_rows),
            "laps":    len(l_rows),
            "json":    json_path.name,
        }
    except Exception as e:
        import traceback
        return {"status": "error", "key": key, "error": str(e),
                "tb": traceback.format_exc()}


# ── Main scan ──────────────────────────────────────────────────────────────────

def scan_and_update(force: bool = False, workers: int | None = None):
    """Scan BASE_DIR for PDFs and process any new/changed ones in parallel."""
    log  = load_log()
    pdfs = sorted(BASE_DIR.rglob("*.pdf"))

    if not pdfs:
        print("No PDFs found.")
        return

    # Split into skip / to-process
    to_process: list[tuple[Path, float]] = []
    skipped = 0
    for pdf_path in pdfs:
        key   = str(pdf_path.relative_to(BASE_DIR))
        mtime = os.path.getmtime(pdf_path)
        if not force and key in log and log[key].get("mtime") == mtime:
            skipped += 1
        else:
            to_process.append((pdf_path, mtime))

    print(f"  PDFs to process : {len(to_process)}")
    print(f"  Skipped (cached): {skipped}")

    if not to_process:
        print("Nothing new to process.")
        return

    n_workers = workers or min(os.cpu_count() or 4, len(to_process))
    print(f"  Workers         : {n_workers}\n")

    mtime_map = {str(p): m for p, m in to_process}
    paths     = [str(p) for p, _ in to_process]

    new_count = 0
    err_count = 0
    done      = 0

    with ProcessPoolExecutor(max_workers=n_workers) as pool:
        futures = {pool.submit(_process_one_pdf, p): p for p in paths}
        for fut in as_completed(futures):
            done += 1
            pdf_path_str = futures[fut]
            try:
                res = fut.result()
            except Exception as e:
                res = {"status": "error", "key": pdf_path_str, "error": str(e)}

            key   = res.get("key", pdf_path_str)
            mtime = mtime_map.get(pdf_path_str, 0.0)

            if res["status"] == "ok":
                new_count += 1
                print(f"  [{done:>4}/{len(paths)}] ✓  {key}  "
                      f"({res['riders']} riders, {res['laps']} laps)")
                log[key] = {
                    "mtime":     mtime,
                    "riders":    res["riders"],
                    "laps":      res["laps"],
                    "processed": datetime.now(timezone.utc).isoformat(),
                }
            elif res["status"] == "no_riders":
                print(f"  [{done:>4}/{len(paths)}] !  {key}  — no riders extracted")
            else:
                err_count += 1
                print(f"  [{done:>4}/{len(paths)}] ✗  {key}  — {res.get('error','?')}")
                if "tb" in res:
                    print(res["tb"])

    save_log(log)

    if new_count == 0:
        print("\nNo sessions updated.")
    else:
        rebuild_index_json()
        print(f"\nDone — {new_count} processed, {err_count} errors.")


# ── Entry point ────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser(description="MotoGP PDF Parser")
    ap.add_argument("pdf", nargs="?", help="Process a single PDF file")
    ap.add_argument("--force",   action="store_true", help="Reprocess all PDFs")
    ap.add_argument("--workers", type=int, default=None,
                    help="Parallel worker count (default: cpu_count)")
    cli = ap.parse_args()
    force   = cli.force
    workers = cli.workers
    args    = [cli.pdf] if cli.pdf else []

    if args:
        target = Path(args[0])
        if not target.is_absolute():
            target = BASE_DIR / target
        print(f"Processing {target} …")
        s_rows, l_rows, session_info = parse_pdf(target)
        if s_rows:
            json_path = write_session_json(s_rows, l_rows, target, session_info)
            rebuild_index_json()
            print(f"Done — {len(s_rows)} riders, {len(l_rows)} laps")
            print(f"  JSON : {json_path.relative_to(BASE_DIR)}")
        else:
            print("No riders extracted.")
    else:
        scan_and_update(force=force, workers=workers)
