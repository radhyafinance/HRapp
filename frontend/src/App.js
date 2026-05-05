import React from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider } from "./contexts/AuthContext";
import ProtectedRoute from "./components/ProtectedRoute";
import Layout from "./components/Layout";
import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";
import Employees from "./pages/Employees";
import Candidates from "./pages/Candidates";
import Attendance from "./pages/Attendance";
import FieldTracking from "./pages/FieldTracking";
import HolidayCalendar from "./pages/HolidayCalendar";
import Leaves from "./pages/Leaves";
import Payroll from "./pages/Payroll";
import Performance from "./pages/Performance";
import ExitManagement from "./pages/ExitManagement";
import Letters from "./pages/Letters";
import Settings from "./pages/Settings";
import Gratuity from "./pages/Gratuity";
import CandidateApply from "./pages/CandidateApply";
import "./App.css";

function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/apply/:token" element={<CandidateApply />} />
          <Route path="/" element={<ProtectedRoute><Layout /></ProtectedRoute>}>
            <Route index element={<Navigate to="/dashboard" replace />} />
            <Route path="dashboard" element={<Dashboard />} />
            <Route path="employees" element={<Employees />} />
            <Route path="candidates" element={<Candidates />} />
            <Route path="attendance" element={<Attendance />} />
            <Route path="field-tracking" element={<FieldTracking />} />
            <Route path="calendar" element={<HolidayCalendar />} />
            <Route path="leaves" element={<Leaves />} />
            <Route path="payroll" element={<Payroll />} />
            <Route path="performance" element={<Performance />} />
            <Route path="exit" element={<ExitManagement />} />
            <Route path="letters" element={<Letters />} />
            <Route path="gratuity" element={<Gratuity />} />
            <Route path="settings" element={<Settings />} />
          </Route>
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}

export default App;
