import React, { useEffect, useState, useRef } from "react";
import { Camera } from "lucide-react";

export function CameraCapture({ onCapture, onClose }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const startCamera = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: "user",
            width: { ideal: 1280 },
            height: { ideal: 960 },
          },
          audio: false,
        });
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          setReady(true);
        }
      } catch (e) {
        setError("Camera access denied. Please allow camera access.");
      }
    };
    startCamera();
    return () => { if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop()); };
  }, []);

  const capture = () => {
    if (!videoRef.current || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const v = videoRef.current;
    const w = Math.min(v.videoWidth || 640, 1280);
    const h = Math.min(v.videoHeight || 480, 960);
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d").drawImage(v, 0, 0, w, h);
    const base64 = canvas.toDataURL("image/jpeg", 0.85).split(",")[1];
    if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());
    onCapture(base64);
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/80 p-4">
      <div className="bg-white rounded-xl p-5 w-full max-w-sm">
        <h3 className="text-lg font-bold text-[#1E2A47] mb-3" style={{ fontFamily: "'Outfit', sans-serif" }}>Take Selfie</h3>
        {error ? (
          <div className="bg-red-50 text-red-700 p-3 rounded-lg text-sm mb-3">{error}</div>
        ) : (
          <div className="relative mb-3">
            <video ref={videoRef} autoPlay playsInline muted className="w-full rounded-lg bg-slate-900" style={{ height: 280, objectFit: "cover" }} />
            <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
              <div className="border-2 border-white/70 border-dashed rounded-full" style={{ width: 160, height: 200 }} />
            </div>
          </div>
        )}
        <p className="text-[11px] text-slate-500 mb-3 text-center">Position your full face inside the oval. Make sure lighting is even.</p>
        <canvas ref={canvasRef} className="hidden" />
        <div className="flex gap-3">
          <button onClick={onClose} className="flex-1 px-4 py-2.5 border-2 border-slate-300 text-slate-600 rounded-lg text-sm font-medium" data-testid="cancel-selfie-btn">Cancel</button>
          <button onClick={capture} disabled={!ready} data-testid="capture-selfie-btn"
            className="flex-1 px-4 py-2.5 bg-[#E85B1E] text-white rounded-lg text-sm font-semibold disabled:opacity-60 flex items-center justify-center gap-2">
            <Camera size={16} /> Capture
          </button>
        </div>
      </div>
    </div>
  );
}
