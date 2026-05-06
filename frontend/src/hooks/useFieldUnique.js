/**
 * Debounced uniqueness check hook for Aadhaar, PAN, Mobile, Email.
 * Checks across both employees + candidates collections.
 */
import { useState, useEffect, useRef } from "react";
import API from "../utils/api";

/**
 * useFieldUnique — debounced field uniqueness check.
 * @param {string} field   - "mobile" | "email" | "aadhaar_number" | "pan_number"
 * @param {string} value   - current field value
 * @param {object} options - { excludeCandidateId, excludeEmployeeId }
 * @param {number} minLen  - don't check until value reaches this length
 * @returns {{ checking: bool, exists: bool|null, info: object|null }}
 */
export function useFieldUnique(field, value, options = {}, minLen = 1) {
  const { excludeCandidateId, excludeEmployeeId } = options;
  const [state, setState] = useState({ checking: false, exists: null, info: null });
  const timerRef = useRef(null);

  useEffect(() => {
    if (!value || value.length < minLen) {
      setState({ checking: false, exists: null, info: null });
      return;
    }
    setState(s => ({ ...s, checking: true, exists: null }));
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(async () => {
      try {
        const params = { field, value };
        if (excludeCandidateId) params.exclude_candidate_id = excludeCandidateId;
        if (excludeEmployeeId) params.exclude_employee_id = excludeEmployeeId;
        const res = await API.get("/candidates/check-unique", { params });
        setState({ checking: false, exists: res.data.exists, info: res.data });
      } catch {
        setState({ checking: false, exists: null, info: null });
      }
    }, 600);
    return () => clearTimeout(timerRef.current);
  }, [field, value, excludeCandidateId, excludeEmployeeId, minLen]);

  return state;
}

/**
 * UniqueHint — small inline status message shown below unique fields.
 */
export function UniqueHint({ checking, exists, info, value, minLen = 1 }) {
  if (!value || value.length < minLen) return null;
  if (checking) {
    return (
      <p className="text-[11px] text-slate-400 mt-1 flex items-center gap-1">
        <span className="inline-block w-2 h-2 border border-slate-400 border-t-transparent rounded-full animate-spin" />
        Checking...
      </p>
    );
  }
  if (exists === true) {
    return (
      <p className="text-[11px] text-red-600 mt-1 font-medium">
        Already registered ({info?.conflict_in}): {info?.conflict_name || info?.conflict_id}
      </p>
    );
  }
  if (exists === false) {
    return <p className="text-[11px] text-green-600 mt-1">Available</p>;
  }
  return null;
}

/**
 * Returns Tailwind border classes for an input based on uniqueness check result.
 */
export function uniqueBorderClass(check, value, minLen = 1) {
  if (!value || value.length < minLen) return "border-slate-300";
  if (check.exists === true) return "border-red-400";
  if (check.exists === false) return "border-green-400";
  return "border-slate-300";
}
