import React, { useEffect, useState, useRef } from "react";
import { MapContainer, TileLayer, Polyline, Marker, Popup, CircleMarker } from "react-leaflet";
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

const stopIcon = new L.DivIcon({
  className: "custom-pin",
  html: '<div style="background:#E85B1E;width:24px;height:24px;border-radius:50%;border:3px solid white;display:flex;align-items:center;justify-content:center;color:white;font-size:11px;font-weight:bold;box-shadow:0 2px 6px rgba(0,0,0,0.3)">!</div>',
  iconSize: [24, 24],
  iconAnchor: [12, 12],
});


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

export default function RouteMap({ locations = [], stops = [], attendance }) {
  const mapRef = useRef(null);
  const points = locations.map((l) => [l.latitude, l.longitude]);

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
            {locations[locations.length - 1]?.timestamp
              ? ` · ${new Date(locations[locations.length - 1].timestamp).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}`
              : ""}
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

        {/* Intermediate point dots */}
        {locations.slice(1, -1).map((l) => (
          <CircleMarker
            key={l.id}
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
              {locations[0]?.timestamp ? new Date(locations[0].timestamp).toLocaleTimeString("en-IN") : "-"}
            </Popup>
          </Marker>
        )}

        {/* End marker */}
        {points.length > 1 && (
          <Marker position={points[points.length - 1]} icon={endIcon}>
            <Popup>
              <strong>{attendance?.punch_out_time ? "End (Punch Out)" : "Last Known Location"}</strong>
              <br />
              {locations[locations.length - 1]?.timestamp
                ? new Date(locations[locations.length - 1].timestamp).toLocaleTimeString("en-IN")
                : "-"}
              <br />
              <GMapsLink lat={points[points.length - 1][0]} lon={points[points.length - 1][1]} />
            </Popup>
          </Marker>
        )}

        {/* Stop markers */}
        {stops.map((s, i) => (
          <Marker key={`stop-${s.latitude}-${s.longitude}-${i}`} position={[s.latitude, s.longitude]} icon={stopIcon}>
            <Popup>
              <strong>Stop #{i + 1}</strong>
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
