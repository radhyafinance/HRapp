import React, { useState } from "react";
import { Eye, Edit3, FileText, MapPin } from "lucide-react";
import { Modal } from "../shared/Modal";
import { EmployeeDetailView } from "./EmployeeDetailView";
import { EmployeeEditForm } from "./EmployeeEditForm";
import { EmployeeDocumentsTab } from "./EmployeeDocumentsTab";
import { EmployeeTrackerTab } from "./EmployeeTrackerTab";
import { useAuth } from "../../contexts/AuthContext";

export function EmployeeModal({ emp, onClose, onUpdated, onDocsChanged }) {
  const { user } = useAuth();
  const canEdit = ["hr_admin", "management"].includes(user?.role);
  const [tab, setTab] = useState(emp._initialTab || "view");
  const [current, setCurrent] = useState(emp);

  const tabs = [["view", "View", Eye]];
  if (canEdit) tabs.push(["edit", "Edit", Edit3]);
  tabs.push(["docs", "Documents", FileText], ["tracker", "Tracker", MapPin]);

  return (
    <Modal title={`${current.first_name} ${current.last_name} (${current.employee_id})`} onClose={onClose} wide>
      <div className="flex gap-1 mb-4 border-b border-slate-200">
        {tabs.map(([val, label, Icon]) => (
          <button key={val} onClick={() => setTab(val)} data-testid={`emp-tab-${val}`}
            className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${tab === val ? "border-[#E85B1E] text-[#E85B1E]" : "border-transparent text-slate-500 hover:text-slate-700"}`}>
            <Icon size={14} /> {label}
          </button>
        ))}
      </div>
      {tab === "view" && <EmployeeDetailView emp={current} />}
      {tab === "edit" && canEdit && (
        <EmployeeEditForm
          emp={current}
          onCancel={() => setTab("view")}
          onSaved={(updated) => {
            setCurrent(updated);
            onUpdated && onUpdated(updated);
            setTab("view");
          }}
        />
      )}
      {tab === "docs" && <EmployeeDocumentsTab employeeId={current.employee_id} onDocsChanged={onDocsChanged} />}
      {tab === "tracker" && <EmployeeTrackerTab employeeId={current.employee_id} />}
    </Modal>
  );
}
