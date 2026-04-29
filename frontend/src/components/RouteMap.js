import React, { useEffect, useState, useRef } from "react";
import { MapContainer, TileLayer, Polyline, Marker, Popup, CircleMarker } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

// Fix default marker icons in Leaflet (CRA path issue)
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
});

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

export default function RouteMap({ locations = [], stops = [], attendance }) {
  const mapRef = useRef(null);
  const points = locations.map((l) => [l.latitude, l.longitude]);

  // Defaults to Moradabad if no points
  const center = points[0] || [28.880786, 78.746678];

  useEffect(() => {
    if (mapRef.current && points.length > 1) {
      const bounds = L.latLngBounds(points);
      mapRef.current.fitBounds(bounds, { padding: [40, 40] });
    }
  }, [points.length]);

  return (
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
          <Polyline positions={points} pathOptions={{ color: "#1E2A47", weight: 4, opacity: 0.85 }} />
        )}

        {/* Intermediate point dots */}
        {locations.slice(1, -1).map((l) => (
          <CircleMarker
            key={l.id}
            center={[l.latitude, l.longitude]}
            radius={3}
            pathOptions={{ color: "#1E2A47", fillColor: "#1E2A47", fillOpacity: 0.8 }}
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
            </Popup>
          </Marker>
        )}

        {/* Stop markers */}
        {stops.map((s, i) => (
          <Marker key={i} position={[s.latitude, s.longitude]} icon={stopIcon}>
            <Popup>
              <strong>Stop #{i + 1}</strong>
              <br />
              Duration: <strong>{s.duration_minutes} min</strong>
              <br />
              From: {new Date(s.start).toLocaleTimeString("en-IN")}
              <br />
              To: {new Date(s.end).toLocaleTimeString("en-IN")}
            </Popup>
          </Marker>
        ))}
      </MapContainer>
    </div>
  );
}
