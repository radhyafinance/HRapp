import React, { useEffect, useState } from "react";
import { X, Image as ImageIcon } from "lucide-react";

export function DocUploadCard({ label, file, onChange, onClear, testid }) {
  const [preview, setPreview] = useState(null);
  useEffect(() => {
    if (!file) { setPreview(null); return; }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  const sizeKb = file ? Math.round(file.size / 1024) : 0;
  return (
    <label className={`relative flex flex-col items-center justify-center border-2 border-dashed rounded-xl p-3 text-center cursor-pointer transition-colors ${file ? "border-[#E85B1E] bg-[#E85B1E]/5" : "border-slate-300 hover:border-slate-400 bg-slate-50/50"}`}>
      {preview ? (
        <>
          <img src={preview} alt={label} className="w-full h-28 object-cover rounded-lg mb-2" />
          <p className="text-xs font-semibold text-[#1E2A47] truncate w-full">{label}</p>
          <p className="text-[10px] text-slate-500">{sizeKb} KB</p>
          <button type="button" onClick={(e) => { e.preventDefault(); onClear(); }} className="absolute top-1 right-1 bg-white/90 rounded-full p-1 text-red-500 hover:bg-white">
            <X size={12} />
          </button>
        </>
      ) : (
        <>
          <ImageIcon size={28} className="text-slate-400 mb-1" />
          <p className="text-xs font-semibold text-slate-700">{label}</p>
          <p className="text-[10px] text-slate-400">Click to upload</p>
        </>
      )}
      <input
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(e) => onChange(e.target.files?.[0] || null)}
        data-testid={testid}
      />
    </label>
  );
}
