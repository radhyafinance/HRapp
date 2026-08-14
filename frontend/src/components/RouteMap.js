import React, { useEffect, useState, useRef } from "react";
import { MapContainer, TileLayer, Polyline, Marker, Popup, CircleMarker, Tooltip } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { MapPin } from "lucide-react";

// Fix default marker icons in Leaflet (CRA path issue)
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
});

// Stable pathOptions constants — avoids inline object re-renders
const ROUTE_PATH_OPTIONS = { color: "#1E2A47", weight: 4, opacity: 0.85 };
const DOT_PATH_OPTIONS = { color: "#1E2A47", fillColor: "#1E2A47", fillOpacity: 0.8 };

const startIcon = new L.DivIcon({
  className: "custom-pin",
  html: '<div style="background:#10B981;width:18px;height:18px;border-radius:50%;border:3px solid white;box-shadow:0 2px 6px rgba(0,0,0,0.3)"></div>',
  iconSize: [18, 18],
  iconAnchor: [9, 9],
});

const endIcon = new L.DivIcon({
  className: "custom-pin",
  html: '<div style="background:#EF4444;width:18px;height:18px;border-radius:50%;border:3px solid white;box-shadow:0 2px 6px rgba(0,0,0,0.3)"></div>',
  iconSize: [18, 18],
  iconAnchor: [9, 9],
});

// Numbered, not an exclamation mark. Every pin used to read "!", so a day with
// nine stops gave you nine identical warnings and no way to say "the third one"
// out loud. The number matches the ordinal the backend assigns, so the pin, the
// popup and the list below all agree.
function stopIcon(n) {
  const size = n >= 100 ? 30 : n >= 10 ? 27 : 24;
  return new L.DivIcon({
    className: "custom-pin",
    html: `<div style="background:#E85B1E;width:${size}px;height:${size}px;border-radius:50%;
      border:3px solid white;display:flex;align-items:center;justify-content:center;color:white;
      font-size:${n >= 100 ? 10 : 12}px;font-weight:800;line-height:1;
      box-shadow:0 2px 6px rgba(0,0,0,0.3)">${n}</div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

// Bearing from a to b, degrees clockwise from north — the rotation for the
// travel arrows.
function bearing(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const y = Math.sin(toRad(b[1] - a[1])) * Math.cos(toRad(b[0]));
  const x = Math.cos(toRad(a[0])) * Math.sin(toRad(b[0]))
          - Math.sin(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.cos(toRad(b[1] - a[1]));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

// A chevron pointing along the direction of travel. Deliberately a DivIcon
// rather than a polyline-decorator dependency: one more npm package in this
// project is a bigger risk than twelve lines of SVG.
function arrowIcon(deg) {
  return new L.DivIcon({
    className: "travel-arrow",
    html: `<div style="transform:rotate(${deg}deg);width:16px;height:16px;line-height:0">
      <svg viewBox="0 0 16 16" width="16" height="16">
        <!-- White on navy: the arrow used to be #1E2A47, the SAME colour as the
             route line it sits on, so it was invisible exactly where it mattered.
             Not the orange of the stop pins either — an arrow is not a stop. -->
        <path d="M8 1 L13 12 L8 9.2 L3 12 Z" fill="white" stroke="#1E2A47"
              stroke-width="1.4" stroke-linejoin="round"/>
      </svg></div>`,
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  });
}


// Straight-line distance between two lat/lon points, in km. Same haversine the
// backend uses for the day's total — a different formula here would put two
// numbers on screen that quietly disagree.
function haversineKm(a, b) {
  if (!a || !b) return null;
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLon = toRad(b[1] - a[1]);
  const lat1 = toRad(a[0]);
  const lat2 = toRad(b[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.sqrt(h));
}

function fmtKm(km) {
  if (km == null) return "—";
  return km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1)} km`;
}

// Opens the native Maps app on a phone and google.com/maps on desktop.
function gmapsUrl(lat, lon) {
  return `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`;
}

function GMapsLink({ lat, lon }) {
  return (
    <a href={gmapsUrl(lat, lon)} target="_blank" rel="noopener noreferrer"
       style={{ color: "#E85B1E", fontWeight: 700, textDecoration: "underline" }}>
      Open in Google Maps
    </a>
  );
}

// A centre from the monthly GRT sheet. Deliberately a different shape and
// colour from the stop pins: a stop is something the officer DID, a centre is a
// fixed place that was there whether he went or not. Same icon for both would
// make the map answer the wrong question.
const centreIcon = new L.DivIcon({
  className: "centre-pin",
  html: `<div style="width:11px;height:11px;background:#0EA5E9;border:2px solid white;
    transform:rotate(45deg);box-shadow:0 1px 3px rgba(0,0,0,.4)"></div>`,
  iconSize: [11, 11],
  iconAnchor: [5.5, 5.5],
});

export default function RouteMap({ locations = [], stops = [], attendance,
                                   trustedLocations, droppedLowAccuracy = 0,
                                   centres = [] }) {
  const mapRef = useRef(null);
  // Draw only fixes the phone itself believes. A quarter of production fixes are
  // 300 m+ (cell tower, not GPS); plotting those as confident dots is what made
  // a parked officer look like he visited ten places. Falls back to the raw set
  // so an older backend response still renders.
  const drawn = (trustedLocations && trustedLocations.length) ? trustedLocations : locations;
  const points = drawn.map((l) => [l.latitude, l.longitude]);

  // Arrows mark TRAVEL, so they are placed only on segments that actually went
  // somewhere. Spacing them evenly by index instead put most of them inside the
  // stationary clusters — where there is no heading to show and the jitter would
  // have them pointing at random. 80 m is comfortably outside the noise floor
  // for a fix we already trust to 100 m.
  const ARROW_MIN_MOVE_M = 80;
  const ARROW_CLEAR_OF_STOP_M = 150;   // keep the numbers readable
  const TARGET_ARROWS = 14;
  const arrows = [];
  const moving = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    if (haversineKm(a, b) * 1000 < ARROW_MIN_MOVE_M) continue;
    // An arrow drawn on top of a stop pin hides the number, which is the one
    // thing that pin exists to show. Measured in metres rather than pixels so it
    // holds at every zoom. The segment leaving a stop is the usual offender.
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const nearStop = stops.some((s) =>
      haversineKm(mid, [s.latitude, s.longitude]) * 1000 < ARROW_CLEAR_OF_STOP_M);
    if (nearStop) continue;
    moving.push([a, b, i]);
  }
  // ceil, not round: this has to be a genuine cap. With round(), 18 travel
  // segments give stride 1 and 18 arrows, so the stated maximum silently is not one.
  const stride = Math.max(1, Math.ceil(moving.length / TARGET_ARROWS));
  for (let k = 0; k < moving.length; k += stride) {
    const [a, b, i] = moving[k];
    arrows.push({ at: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], deg: bearing(a, b), key: `ar-${i}` });
  }

  // Centres NEAR THE ROUTE, not merely inside its bounding box. The box is a
  // rectangle around the whole day, so on a route that runs diagonally it swept
  // in centres 5 km off the path that the officer never went near — 43 of them
  // on a test day, which is too many to label and mostly irrelevant anyway.
  // The question HR is asking is "which centres did he go to", so proximity to
  // the actual path is the right filter, and it leaves few enough to name.
  const CENTRE_NEAR_ROUTE_M = 1500;
  const nearbyCentres = (() => {
    if (!centres.length || !points.length) return [];
    const lats = points.map((p) => p[0]), lons = points.map((p) => p[1]);
    const pad = 0.02;
    const s = Math.min(...lats) - pad, n = Math.max(...lats) + pad;
    const w = Math.min(...lons) - pad, e = Math.max(...lons) + pad;
    return centres.filter((c) => {
      // Cheap rectangle first; the haversine only runs for survivors.
      if (c.latitude < s || c.latitude > n || c.longitude < w || c.longitude > e) return false;
      const here = [c.latitude, c.longitude];
      for (let i = 0; i < points.length; i++) {
        if (haversineKm(here, points[i]) * 1000 <= CENTRE_NEAR_ROUTE_M) return true;
      }
      return false;
    });
  })();

  // Distance from the previous stop — what "how far did they travel between calls"
  // actually means. The first stop measures from the day's start point instead.
  const stopLegKm = stops.map((st, i) => {
    const here = [st.latitude, st.longitude];
    const prev = i === 0 ? points[0] : [stops[i - 1].latitude, stops[i - 1].longitude];
    return haversineKm(prev, here);
  });

  // Defaults to Moradabad if no points
  const center = points[0] || [28.880786, 78.746678];

  useEffect(() => {
    if (mapRef.current && points.length > 1) {
      const bounds = L.latLngBounds(points);
      mapRef.current.fitBounds(bounds, { padding: [40, 40] });
    }
  }, [points.length]);

  const latest = points.length ? points[points.length - 1] : null;
  const isLive = !attendance?.punch_out_time;

  return (
    <div className="w-full space-y-2">
      {/* Latest position, one tap away. The marker popup carries the same link, but
          this is the version you can find without knowing to click the map first. */}
      {latest && (
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <p className="text-xs text-slate-500">
            {isLive ? "Live location" : "Last known location"}
            {drawn[drawn.length - 1]?.timestamp
              ? ` · ${new Date(drawn[drawn.length - 1].timestamp).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}`
              : ""}
            {/* Said out loud rather than silently dropped. "Fewer dots than I
                expected" should have a reason on screen, not be a mystery. */}
            {droppedLowAccuracy > 0 && (
              <span className="text-amber-700">
                {" "}· {droppedLowAccuracy} low-accuracy fix{droppedLowAccuracy > 1 ? "es" : ""} hidden
              </span>
            )}
          </p>
          <a
            href={gmapsUrl(latest[0], latest[1])}
            target="_blank" rel="noopener noreferrer"
            data-testid="open-in-gmaps"
            className="flex items-center gap-1.5 px-3 py-1.5 bg-[#E85B1E] text-white rounded-lg text-xs font-semibold hover:bg-[#D04A15]"
          >
            <MapPin size={12} /> Open in Google Maps
          </a>
        </div>
      )}
      <div className="w-full rounded-xl overflow-hidden border border-slate-200" style={{ height: 500 }}>
      <MapContainer
        center={center}
        zoom={13}
        style={{ width: "100%", height: "100%" }}
        ref={mapRef}
        scrollWheelZoom={true}
      >
        <TileLayer
          attribution='&copy; OpenStreetMap contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />

        {points.length > 1 && (
          <Polyline positions={points} pathOptions={ROUTE_PATH_OPTIONS} />
        )}

        {/* Centres from the GRT sheet. Rendered BEFORE the route so the day's
            own markers stay on top of them. */}
        {nearbyCentres.map((c, ci) => (
          <Marker key={`c-${c.centre}-${c.latitude}-${c.longitude}`}
                  position={[c.latitude, c.longitude]} icon={centreIcon}>
            {/* Permanent: the centre name IS the point of drawing these. Left
                as hover-only they were just identical blue diamonds. */}
            {/* shadowPane (z 500) sits BELOW markerPane (z 600). Left in the
                default tooltip pane (z 650) these labels drew on top of the
                numbered stop pins — burying the one thing on the map you most
                need to read. */}
            {/* Alternating sides. Centres cluster along a road, so every label
                on the right produced a vertical stack that overlapped itself.
                Leaflet does no collision avoidance, and this halves it for free. */}
            <Tooltip direction={ci % 2 ? "left" : "right"}
                     offset={ci % 2 ? [-7, 0] : [7, 0]} opacity={0.92}
                     permanent pane="shadowPane" className="centre-label">
              {/* Name only. The branch was on every label and identical for
                  every centre in view, so it doubled the width of each one and
                  told you nothing. It is still in the popup. */}
              <strong>{c.centre}</strong>
            </Tooltip>
            <Popup>
              <strong>{c.centre}</strong>
              {c.branch ? <><br />Branch: {c.branch}</> : null}
              {c.spread_m >= 1000 && (
                <><br /><span style={{ color: "#b45309" }}>
                  Location uncertain — the sheet's fixes for this centre disagree by{" "}
                  {(c.spread_m / 1000).toFixed(1)} km
                </span></>
              )}
              <br />
              <GMapsLink lat={c.latitude} lon={c.longitude} />
            </Popup>
          </Marker>
        ))}

        {/* Direction of travel */}
        {arrows.map((a) => (
          <Marker key={a.key} position={a.at} icon={arrowIcon(a.deg)} interactive={false} />
        ))}

        {/* Intermediate point dots */}
        {drawn.slice(1, -1).map((l, i) => (
          <CircleMarker
            key={l.id || `pt-${i}`}
            center={[l.latitude, l.longitude]}
            radius={3}
            pathOptions={DOT_PATH_OPTIONS}
          />
        ))}

        {/* Start marker */}
        {points.length > 0 && (
          <Marker position={points[0]} icon={startIcon}>
            <Popup>
              <strong>Start (Punch In)</strong>
              <br />
              {drawn[0]?.timestamp ? new Date(drawn[0].timestamp).toLocaleTimeString("en-IN") : "-"}
            </Popup>
          </Marker>
        )}

        {/* End marker */}
        {points.length > 1 && (
          <Marker position={points[points.length - 1]} icon={endIcon}>
            <Popup>
              <strong>{attendance?.punch_out_time ? "End (Punch Out)" : "Last Known Location"}</strong>
              <br />
              {drawn[drawn.length - 1]?.timestamp
                ? new Date(drawn[drawn.length - 1].timestamp).toLocaleTimeString("en-IN")
                : "-"}
              <br />
              <GMapsLink lat={points[points.length - 1][0]} lon={points[points.length - 1][1]} />
            </Popup>
          </Marker>
        )}

        {/* Stop markers */}
        {stops.map((s, i) => (
          <Marker key={`stop-${s.latitude}-${s.longitude}-${i}`} position={[s.latitude, s.longitude]}
                  icon={stopIcon(s.index ?? i + 1)}>
            <Popup>
              <strong>Stop #{s.index ?? i + 1}</strong>
              <br />
              Duration: <strong>{s.duration_minutes} min</strong>
              <br />
              {i === 0 ? "From start: " : "From stop #" + i + ": "}
              <strong>{fmtKm(stopLegKm[i])}</strong>
              <br />
              From: {new Date(s.start).toLocaleTimeString("en-IN")}
              <br />
              To: {new Date(s.end).toLocaleTimeString("en-IN")}
              <br />
              <GMapsLink lat={s.latitude} lon={s.longitude} />
            </Popup>
          </Marker>
        ))}
      </MapContainer>
      </div>
    </div>
  );
}
