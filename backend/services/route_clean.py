"""One cleaned version of a field officer's day, for the route map AND the distance.

WHY THIS EXISTS
---------------
The route map joined every location fix in time order. An officer sitting in a
branch for six hours produces ~170 fixes; half are within 5 m of where they sat,
but a tenth stray 20-165 m (Wi-Fi, cell, GPS bouncing off walls). Joined up, at
street zoom, those strays draw a star around the stop. Measured 2026-08-30 to
09-14 across 24 field staff: strays over 50 m inside stops on 125 of 134 days,
a median of 14 a day, and the same wobble added a median 0.65 km (p90 1.7 km)
of distance to people who were sitting still.

What this does, in order:
  1. Keeps fixes the phone itself claims to within 100 m (as before).
  2. Clusters consecutive fixes into stays (as before: a 60 m radius, widened
     to each fix's own accuracy, re-centred as the stay grows).
  3. Merges stays that are the same place. Two changes from before:
       - a short stray cluster between two halves no longer blocks the merge
         (it used to split one six-hour branch visit into two pins, 7 m apart);
       - a gap of up to 45 minutes no longer splits a stop when nothing in
         the gap is evidence of leaving: every fix in it is coarse (worse
         than 30 m). A single accurate fix elsewhere keeps them apart, and a
         gap with no fixes at all still splits after 12 minutes;
       - stays backed by real GPS (most fixes report speed, median <= 25 m)
         merge only within 60 m, not 150 m. A consistent 80 m excursion on GPS
         is a real walk to the next house, and must not be swallowed by the
         stop. Wi-Fi fixes do NOT qualify, however accurate they claim to be:
         they report a flat 20 m and alternate between access points 140 m
         apart, which would split one evening at home into three stops.
  4. Classifies: >= 15 min is a STOP (numbered, as before); 5-15 min with at
     least 3 fixes is a PAUSE (a short visit, drawn as a small grey dot).
  5. Builds the ROUTE: every stop and pause collapses to one vertex at its
     centre; fixes in between are travel. A single out-and-back jump (the
     fixes either side of it are within 40 m of each other and at most 10
     minutes apart, and it is 50-500 m from both) is dropped unless it is
     accurate GPS reporting movement.
  6. Measures DISTANCE along that route, with the same gates as before:
     hops under 30 m are jitter, hops implying more than 150 km/h are bad fixes.

The route map, the stops table and every distance figure come from this one
function, so the kilometres on the Distance tab can never disagree with the
line drawn on the map.
"""
import math
from datetime import datetime, timezone
from typing import Optional

TRUST_ACCURACY_M = 100      # worse than this is an area, not a position
STAY_RADIUS_M = 60          # base stay radius; widened per fix by its own accuracy
STOP_MIN_MIN = 15           # a numbered stop, as before
PAUSE_MIN_MIN = 5           # a short visit worth a grey dot...
PAUSE_MIN_POINTS = 3        # ...if at least this many fixes agree on it
MERGE_GAP_MIN = 12          # two stays this close in time may be one place...
MERGE_GAP_COARSE_MIN = 45   # ...or this close, if every fix in the gap is coarse
CREDIBLE_AWAY_M = 30        # a fix this accurate, away from the stay, means they left
MERGE_M_COARSE = 150        # ...if within this, when either stay is coarse
MERGE_M_FINE = 60           # ...or within this, when both are accurate
FINE_ACCURACY_M = 25        # median accuracy at or under this counts as accurate...
FINE_GPS_SHARE = 0.5        # ...only if at least this share of fixes are GPS (carry speed)
SPIKE_RETURN_M = 40         # the fixes either side of a spike agree to within this
SPIKE_OUT_M = 50            # and the spike is at least this far from both...
SPIKE_MAX_OUT_M = 500       # ...but no further: a lone accurate fix 3 km out is a trip, not noise
SPIKE_MAX_SPAN_MIN = 10     # ...and the fixes either side are this close in time
MOVING_SPEED_MS = 1.0       # accurate GPS reporting at least this is real movement
GOOD_GPS_M = 20
MIN_MOVE_M = 30             # distance: shorter hops are jitter
MAX_SPEED_MS = 42.0         # distance: ~150 km/h; faster-implied hops are bad fixes


def haversine_m(lat1, lon1, lat2, lon2):
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlmb = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlmb / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def _pt_time(p) -> Optional[datetime]:
    try:
        t = datetime.fromisoformat(str(p.get("timestamp")).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    # The ingest writes UTC with an offset. A naive value is read as UTC rather
    # than left naive, because comparing the two kinds raises and would take
    # the whole route map down over one odd row.
    return t if t.tzinfo else t.replace(tzinfo=timezone.utc)


def _median(values):
    vals = sorted(v for v in values if v is not None)
    if not vals:
        return None
    mid = len(vals) // 2
    return vals[mid] if len(vals) % 2 else (vals[mid - 1] + vals[mid]) / 2


def _trusted(logs):
    """(trusted fixes sorted by time with their parsed time, dropped count)."""
    out, dropped = [], 0
    for p in logs:
        if p.get("latitude") is None or p.get("longitude") is None:
            dropped += 1
            continue
        acc = p.get("accuracy")
        if acc is not None and acc > TRUST_ACCURACY_M:
            dropped += 1
            continue
        t = _pt_time(p)
        if t is None:
            dropped += 1
            continue
        out.append((t, p))
    out.sort(key=lambda x: x[0])
    return out, dropped


def _raw_stays(pts):
    """Consecutive fixes within a (per-fix widened) radius of a running centre."""
    stays, i, n = [], 0, len(pts)
    while i < n:
        members = [pts[i]]
        c_lat, c_lon = pts[i][1]["latitude"], pts[i][1]["longitude"]
        j = i + 1
        while j < n:
            p = pts[j][1]
            tol = max(STAY_RADIUS_M, p.get("accuracy") or 0)
            if haversine_m(c_lat, c_lon, p["latitude"], p["longitude"]) > tol:
                break
            members.append(pts[j])
            c_lat = sum(m[1]["latitude"] for m in members) / len(members)
            c_lon = sum(m[1]["longitude"] for m in members) / len(members)
            j += 1
        if len(members) > 1:
            stays.append({
                "lat": c_lat, "lon": c_lon,
                "t0": members[0][0], "t1": members[-1][0],
                "n": len(members),
                "acc": _median([m[1].get("accuracy") for m in members]),
                "gps": sum(1 for m in members if m[1].get("speed") is not None),
            })
        i = max(j, i + 1)
    return stays


def _minutes(a, b):
    return (b - a).total_seconds() / 60


def _left_during_gap(pts, prev, s, limit):
    """Did anything between two stays show the officer somewhere else?

    None if the gap holds no fixes at all (no evidence either way)."""
    gap = [p for t, p in pts if prev["t1"] < t < s["t0"]]
    if not gap:
        return None
    for p in gap:
        acc = p.get("accuracy")
        if acc is not None and acc <= CREDIBLE_AWAY_M and haversine_m(
                prev["lat"], prev["lon"], p["latitude"], p["longitude"]) > limit:
            return True
    return False


def _merge_limit(a, b):
    fine = all(x["acc"] is not None and x["acc"] <= FINE_ACCURACY_M
               and x["gps"] >= FINE_GPS_SHARE * x["n"] for x in (a, b))
    return MERGE_M_FINE if fine else MERGE_M_COARSE


def _absorb(prev, s):
    w1, w2 = prev["n"], s["n"]
    prev["lat"] = (prev["lat"] * w1 + s["lat"] * w2) / (w1 + w2)
    prev["lon"] = (prev["lon"] * w1 + s["lon"] * w2) / (w1 + w2)
    prev["t1"] = s["t1"]
    prev["n"] = w1 + w2
    prev["gps"] += s["gps"]
    prev["acc"] = _median([prev["acc"], s["acc"]])


def _is_anchor(s):
    mins = _minutes(s["t0"], s["t1"])
    # A pause's worth of agreeing fixes, or simply long enough to be a stop (a
    # phone that went quiet for 20 minutes can bracket a real stop with 2 fixes).
    return (s["n"] >= PAUSE_MIN_POINTS and mins >= PAUSE_MIN_MIN) or mins >= STOP_MIN_MIN


def _merge(stays, pts):
    """Merge stays that are one place, in two passes.

    Pass 1 is the original rule over every stay: close in space, at most 12
    minutes apart. It lets a stop grow to include the short stays at its edges.
    Pass 2 runs over the results that are big enough to matter, so a stray
    cluster between two halves of a stop is skipped rather than splitting it,
    and a longer gap is bridged when nothing in it shows the officer elsewhere.
    """
    first = []
    for s in stays:
        s = dict(s)
        if first:
            prev = first[-1]
            gap = _minutes(prev["t1"], s["t0"])
            if 0 <= gap <= MERGE_GAP_MIN and haversine_m(
                    prev["lat"], prev["lon"], s["lat"], s["lon"]) <= _merge_limit(prev, s):
                _absorb(prev, s)
                continue
        first.append(s)

    merged = []
    for s in (x for x in first if _is_anchor(x)):
        if merged:
            prev = merged[-1]
            gap = _minutes(prev["t1"], s["t0"])
            limit = _merge_limit(prev, s)
            close = haversine_m(prev["lat"], prev["lon"], s["lat"], s["lon"]) <= limit
            # Even a short gap is not merged when an accurate fix in it shows
            # the officer somewhere else: skipping the small clusters between
            # anchors must not swallow a real 10-minute trip out and back.
            left = _left_during_gap(pts, prev, s, limit)
            if close and ((0 <= gap <= MERGE_GAP_MIN and left is not True)
                          or (MERGE_GAP_MIN < gap <= MERGE_GAP_COARSE_MIN and left is False)):
                _absorb(prev, s)
                continue
        merged.append(s)
    return merged


def _iso(t: datetime) -> str:
    return t.isoformat()


def clean_day(logs):
    """The cleaned day. `logs` are location_logs documents in any order.

    Returns a dict:
      stops          numbered stays of 15 min+, same shape as before
      pauses         5-15 min stays with 3+ fixes
      route          vertices to draw: {latitude, longitude, timestamp, kind,
                     [index]} with kind travel | stop | pause
      trusted        the fixes within 100 m, unchanged (for anything still using it)
      dropped        fixes excluded for accuracy, as before
      spikes_removed single out-and-back jumps dropped from the route
      distance_km    measured along the route
    """
    pts, dropped = _trusted(logs)
    trusted = [p for _, p in pts]
    clusters = _merge(_raw_stays(pts), pts)

    stops, pauses = [], []
    for c in clusters:
        mins = _minutes(c["t0"], c["t1"])
        base = {"latitude": round(c["lat"], 6), "longitude": round(c["lon"], 6),
                "start": _iso(c["t0"]), "end": _iso(c["t1"]),
                "points": 0, "duration_minutes": round(mins, 1)}
        if mins >= STOP_MIN_MIN:
            base["index"] = len(stops) + 1
            stops.append(base)
            c["kind"], c["out"] = "stop", base
        elif c["n"] >= PAUSE_MIN_POINTS and mins >= PAUSE_MIN_MIN:
            pauses.append(base)
            c["kind"], c["out"] = "pause", base
        else:
            c["kind"] = None

    kept = [c for c in clusters if c["kind"]]

    # Walk the fixes once. Clusters do not overlap in time, so each fix is either
    # inside exactly one kept cluster's window or it is travel.
    route, ci = [], 0
    for t, p in pts:
        while ci < len(kept) and t > kept[ci]["t1"]:
            ci += 1
        c = kept[ci] if ci < len(kept) and kept[ci]["t0"] <= t <= kept[ci]["t1"] else None
        if c is not None:
            c["out"]["points"] += 1
            if route and route[-1].get("_cluster") is c:
                continue
            v = {"latitude": c["out"]["latitude"], "longitude": c["out"]["longitude"],
                 "timestamp": c["out"]["start"], "end": c["out"]["end"], "kind": c["kind"],
                 "_cluster": c, "_t0": c["t0"], "_t1": c["t1"]}
            if c["kind"] == "stop":
                v["index"] = c["out"]["index"]
            route.append(v)
        else:
            route.append({"latitude": p["latitude"], "longitude": p["longitude"],
                          "timestamp": p.get("timestamp"), "kind": "travel",
                          "_t0": t, "_t1": t, "_acc": p.get("accuracy"), "_speed": p.get("speed")})

    # Single out-and-back jumps between two fixes that agree with each other.
    spikes = 0
    cleaned = []
    for i, v in enumerate(route):
        if v["kind"] == "travel" and 0 < i < len(route) - 1:
            a, c = cleaned[-1] if cleaned else route[i - 1], route[i + 1]
            moving = (v.get("_speed") is not None and v["_speed"] >= MOVING_SPEED_MS
                      and v.get("_acc") is not None and 0 < v["_acc"] <= GOOD_GPS_M)
            out_a = haversine_m(a["latitude"], a["longitude"], v["latitude"], v["longitude"])
            out_c = haversine_m(v["latitude"], v["longitude"], c["latitude"], c["longitude"])
            span_min = _minutes(a["_t1"], c["_t0"])
            if (not moving
                    and 0 <= span_min <= SPIKE_MAX_SPAN_MIN
                    and haversine_m(a["latitude"], a["longitude"], c["latitude"], c["longitude"]) < SPIKE_RETURN_M
                    and SPIKE_OUT_M < out_a <= SPIKE_MAX_OUT_M
                    and SPIKE_OUT_M < out_c <= SPIKE_MAX_OUT_M):
                spikes += 1
                continue
        cleaned.append(v)

    # Distance along the route. A stop is left at its end time, so a long stop
    # followed by a real trip is never mistaken for an impossible speed.
    total, anchor = 0.0, None
    for v in cleaned:
        if anchor is not None:
            seg = haversine_m(anchor["latitude"], anchor["longitude"], v["latitude"], v["longitude"])
            if seg < MIN_MOVE_M:
                if v["kind"] != "travel":
                    anchor = v          # arriving at a stop re-anchors on its centre
                continue
            dt = (v["_t0"] - anchor["_t1"]).total_seconds()
            if dt > 0 and seg / dt > MAX_SPEED_MS:
                continue
            total += seg
        anchor = v

    for v in cleaned:
        for k in ("_cluster", "_t0", "_t1", "_acc", "_speed"):
            v.pop(k, None)
        if v["kind"] == "travel":
            v.pop("end", None)

    return {
        "stops": stops,
        "pauses": pauses,
        "route": cleaned,
        "trusted": trusted,
        "dropped": dropped,
        "spikes_removed": spikes,
        "distance_km": round(total / 1000.0, 2),
    }
