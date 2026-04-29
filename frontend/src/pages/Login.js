import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";
import { Eye, EyeOff, LogIn } from "lucide-react";

export default function Login() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const { login } = useAuth();
  const navigate = useNavigate();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      await login(username.trim(), password);
      navigate("/dashboard");
    } catch (err) {
      const detail = err.response?.data?.detail;
      setError(typeof detail === "string" ? detail : "Invalid username or password");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex" style={{ fontFamily: "'Work Sans', sans-serif" }}>
      {/* Left Panel */}
      <div className="hidden lg:flex w-1/2 bg-[#1E2A47] flex-col items-center justify-center p-12 relative overflow-hidden">
        <div className="absolute inset-0 opacity-10">
          <div className="absolute top-20 left-20 w-64 h-64 bg-[#E85B1E] rounded-full blur-3xl"></div>
          <div className="absolute bottom-20 right-20 w-48 h-48 bg-[#E85B1E] rounded-full blur-3xl"></div>
        </div>
        <div className="relative z-10 text-center">
          <img
            src="https://customer-assets.emergentagent.com/job_9e8a8b1c-6fe9-429d-9ba5-f0ea612fef99/artifacts/8ah2vnvp_Main_Logo%20File-08.png"
            alt="Radhya Micro Finance"
            className="w-48 h-48 object-contain mx-auto mb-8"
          />
          <h1 className="text-white text-4xl font-bold mb-3" style={{ fontFamily: "'Outfit', sans-serif" }}>
            HR Management
          </h1>
          <p className="text-slate-300 text-lg">Radhya Micro Finance Pvt. Ltd.</p>
          <div className="mt-10 grid grid-cols-2 gap-4 text-left">
            {["Employee Management", "Attendance Tracking", "Payroll Processing", "Performance Reviews"].map(f => (
              <div key={f} className="flex items-center gap-2 text-slate-300 text-sm">
                <div className="w-2 h-2 rounded-full bg-[#E85B1E] flex-shrink-0"></div>
                {f}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Right Panel */}
      <div className="flex-1 flex flex-col items-center justify-center p-6 bg-[#F8FAFC]">
        <div className="w-full max-w-md">
          <div className="lg:hidden flex justify-center mb-8">
            <img
              src="https://customer-assets.emergentagent.com/job_9e8a8b1c-6fe9-429d-9ba5-f0ea612fef99/artifacts/r2mv4l59_Icons-03.png"
              alt="Radhya"
              className="w-16 h-16 object-contain"
            />
          </div>

          <h2 className="text-3xl font-bold text-[#1E2A47] mb-1" style={{ fontFamily: "'Outfit', sans-serif" }}>
            Welcome back
          </h2>
          <p className="text-slate-500 mb-8">Sign in to your HR account</p>

          <form onSubmit={handleSubmit} className="space-y-5">
            <div>
              <label className="block text-sm font-semibold text-[#0F172A] mb-1.5" data-testid="username-label">
                Username
              </label>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="admin or RMF0001"
                required
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck="false"
                data-testid="username-input"
                className="w-full border border-slate-300 rounded-lg px-4 py-3 text-[#0F172A] focus:ring-2 focus:ring-[#E85B1E] focus:border-transparent outline-none transition-all text-sm"
              />
              <p className="text-xs text-slate-500 mt-1">Use your <strong>Employee ID</strong> (e.g. RMF0001) or <strong>admin</strong> for HR.</p>
            </div>
            <div>
              <label className="block text-sm font-semibold text-[#0F172A] mb-1.5">Password</label>
              <div className="relative">
                <input
                  type={showPass ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter your password"
                  required
                  data-testid="password-input"
                  className="w-full border border-slate-300 rounded-lg px-4 py-3 pr-12 text-[#0F172A] focus:ring-2 focus:ring-[#E85B1E] focus:border-transparent outline-none transition-all text-sm"
                />
                <button
                  type="button"
                  onClick={() => setShowPass(!showPass)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                >
                  {showPass ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
            </div>

            {error && (
              <div data-testid="login-error" className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              data-testid="login-submit-button"
              className="w-full bg-[#E85B1E] hover:bg-[#D04A15] text-white font-semibold py-3 px-6 rounded-lg flex items-center justify-center gap-2 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {loading ? (
                <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
              ) : (
                <>
                  <LogIn size={18} />
                  Sign In
                </>
              )}
            </button>
          </form>

          <p className="mt-8 text-center text-xs text-slate-400">
            Radhya Micro Finance Private Limited &copy; {new Date().getFullYear()}
          </p>
        </div>
      </div>
    </div>
  );
}
