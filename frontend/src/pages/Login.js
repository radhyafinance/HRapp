import React, { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";
import API from "../utils/api";
import { Eye, EyeOff, LogIn, Mail, KeyRound, Send, ArrowLeft } from "lucide-react";

export default function Login() {
  const [mode, setMode] = useState("password");      // "password" | "otp-request" | "otp-verify"
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [otp, setOtp] = useState("");
  const [maskedEmail, setMaskedEmail] = useState("");
  const [resendIn, setResendIn] = useState(0);       // seconds until user can request another OTP
  const [showPass, setShowPass] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const { login, loginWithToken } = useAuth();
  const navigate = useNavigate();

  // Resend cooldown countdown
  useEffect(() => {
    if (resendIn <= 0) return;
    const t = setInterval(() => setResendIn((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(t);
  }, [resendIn]);

  const resetMessages = () => { setError(""); setInfo(""); };

  const handlePasswordLogin = async (e) => {
    e.preventDefault();
    resetMessages();
    setLoading(true);
    try {
      await login(username.trim(), password);
      navigate("/dashboard");
    } catch (err) {
      const d = err.response?.data?.detail;
      setError(typeof d === "string" ? d : "Invalid username or password");
    } finally {
      setLoading(false);
    }
  };

  const handleOtpRequest = async (e) => {
    if (e) e.preventDefault();
    resetMessages();
    if (!username.trim()) { setError("Please enter your Username / Employee ID."); return; }
    setLoading(true);
    try {
      const res = await API.post("/auth/otp/request", { username: username.trim() });
      setMaskedEmail(res.data.email_masked || "");
      setInfo(`OTP sent to ${res.data.email_masked}. It expires in 10 minutes.`);
      setMode("otp-verify");
      setResendIn(60);
    } catch (err) {
      const d = err.response?.data?.detail;
      setError(typeof d === "string" ? d : "Could not send OTP. Try again or use password.");
    } finally {
      setLoading(false);
    }
  };

  const handleOtpVerify = async (e) => {
    e.preventDefault();
    resetMessages();
    if (!otp.trim() || otp.trim().length < 4) { setError("Enter the 6-digit OTP from your email."); return; }
    setLoading(true);
    try {
      const res = await API.post("/auth/otp/verify", { username: username.trim(), otp: otp.trim() });
      loginWithToken(res.data.access_token, res.data.user);
      navigate("/dashboard");
    } catch (err) {
      const d = err.response?.data?.detail;
      setError(typeof d === "string" ? d : "OTP verification failed.");
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

          {/* Mode tabs (shown only on the initial step) */}
          {mode !== "otp-verify" && (
            <div className="grid grid-cols-2 gap-1 mb-5 bg-slate-100 rounded-lg p-1" data-testid="login-mode-tabs">
              <button type="button" onClick={() => { setMode("password"); resetMessages(); }} data-testid="mode-password-tab"
                className={`flex items-center justify-center gap-1.5 py-2 rounded-md text-sm font-semibold transition-colors ${mode === "password" ? "bg-white text-[#1E2A47] shadow" : "text-slate-500 hover:text-slate-700"}`}>
                <KeyRound size={14} /> Password
              </button>
              <button type="button" onClick={() => { setMode("otp-request"); resetMessages(); }} data-testid="mode-otp-tab"
                className={`flex items-center justify-center gap-1.5 py-2 rounded-md text-sm font-semibold transition-colors ${mode === "otp-request" ? "bg-white text-[#1E2A47] shadow" : "text-slate-500 hover:text-slate-700"}`}>
                <Mail size={14} /> Email OTP
              </button>
            </div>
          )}

          {mode === "password" && (
            <form onSubmit={handlePasswordLogin} className="space-y-5" data-testid="password-login-form">
              <div>
                <label className="block text-sm font-semibold text-[#0F172A] mb-1.5" data-testid="username-label">
                  Username
                </label>
                <input type="text" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="admin or RMF0001" required
                  autoCapitalize="none" autoCorrect="off" spellCheck="false" data-testid="username-input"
                  className="w-full border border-slate-300 rounded-lg px-4 py-3 text-[#0F172A] focus:ring-2 focus:ring-[#E85B1E] focus:border-transparent outline-none transition-all text-sm" />
                <p className="text-xs text-slate-500 mt-1">Use your <strong>Employee ID</strong> (e.g. RMF0001) or <strong>admin</strong> for HR.</p>
              </div>
              <div>
                <label className="block text-sm font-semibold text-[#0F172A] mb-1.5">Password</label>
                <div className="relative">
                  <input type={showPass ? "text" : "password"} value={password} onChange={(e) => setPassword(e.target.value)}
                    placeholder="Enter your password" required data-testid="password-input"
                    className="w-full border border-slate-300 rounded-lg px-4 py-3 pr-12 text-[#0F172A] focus:ring-2 focus:ring-[#E85B1E] focus:border-transparent outline-none transition-all text-sm" />
                  <button type="button" onClick={() => setShowPass(!showPass)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
                    {showPass ? <EyeOff size={18} /> : <Eye size={18} />}
                  </button>
                </div>
              </div>

              {error && <div data-testid="login-error" className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">{error}</div>}

              <button type="submit" disabled={loading} data-testid="login-submit-button"
                className="w-full bg-[#E85B1E] hover:bg-[#D04A15] text-white font-semibold py-3 px-6 rounded-lg flex items-center justify-center gap-2 transition-colors disabled:opacity-60 disabled:cursor-not-allowed">
                {loading ? <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" /> : <><LogIn size={18} /> Sign In</>}
              </button>
            </form>
          )}

          {mode === "otp-request" && (
            <form onSubmit={handleOtpRequest} className="space-y-5" data-testid="otp-request-form">
              <div>
                <label className="block text-sm font-semibold text-[#0F172A] mb-1.5">Username / Employee ID</label>
                <input type="text" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="RMF0001 or admin" required
                  autoCapitalize="none" autoCorrect="off" spellCheck="false" data-testid="otp-username-input"
                  className="w-full border border-slate-300 rounded-lg px-4 py-3 text-[#0F172A] focus:ring-2 focus:ring-[#E85B1E] focus:border-transparent outline-none transition-all text-sm" />
                <p className="text-xs text-slate-500 mt-1">We'll email a 6-digit code to the address on your record.</p>
              </div>

              {error && <div data-testid="login-error" className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">{error}</div>}

              <button type="submit" disabled={loading} data-testid="otp-request-btn"
                className="w-full bg-[#E85B1E] hover:bg-[#D04A15] text-white font-semibold py-3 px-6 rounded-lg flex items-center justify-center gap-2 transition-colors disabled:opacity-60">
                {loading ? <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" /> : <><Send size={18} /> Send OTP</>}
              </button>
            </form>
          )}

          {mode === "otp-verify" && (
            <form onSubmit={handleOtpVerify} className="space-y-5" data-testid="otp-verify-form">
              <button type="button" onClick={() => { setMode("otp-request"); setOtp(""); resetMessages(); }} data-testid="otp-back-btn"
                className="text-xs text-slate-500 hover:text-slate-700 flex items-center gap-1">
                <ArrowLeft size={12} /> Back
              </button>
              <div className="bg-blue-50 border border-blue-100 rounded-lg p-3 text-sm text-blue-800" data-testid="otp-info">
                Code sent to <strong className="font-mono">{maskedEmail}</strong>. Check spam if you don't see it.
              </div>
              <div>
                <label className="block text-sm font-semibold text-[#0F172A] mb-1.5">Enter 6-digit OTP</label>
                <input type="text" inputMode="numeric" pattern="[0-9]*" maxLength={6} value={otp}
                  onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))} placeholder="000000" required
                  data-testid="otp-input" autoFocus
                  className="w-full border border-slate-300 rounded-lg px-4 py-3 text-center text-2xl tracking-[0.5em] font-mono text-[#0F172A] focus:ring-2 focus:ring-[#E85B1E] focus:border-transparent outline-none transition-all" />
              </div>

              {error && <div data-testid="login-error" className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">{error}</div>}
              {info && !error && <div className="bg-green-50 border border-green-200 text-green-700 px-4 py-3 rounded-lg text-sm" data-testid="otp-info-banner">{info}</div>}

              <button type="submit" disabled={loading || otp.length < 6} data-testid="otp-verify-btn"
                className="w-full bg-[#E85B1E] hover:bg-[#D04A15] text-white font-semibold py-3 px-6 rounded-lg flex items-center justify-center gap-2 transition-colors disabled:opacity-60 disabled:cursor-not-allowed">
                {loading ? <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" /> : <><LogIn size={18} /> Verify & Sign In</>}
              </button>

              <button type="button" onClick={handleOtpRequest} disabled={resendIn > 0 || loading} data-testid="otp-resend-btn"
                className="w-full text-sm text-[#E85B1E] hover:underline disabled:text-slate-400 disabled:no-underline disabled:cursor-not-allowed">
                {resendIn > 0 ? `Resend code in ${resendIn}s` : "Resend OTP"}
              </button>
            </form>
          )}

          <p className="mt-8 text-center text-xs text-slate-400">
            Radhya Micro Finance Private Limited &copy; {new Date().getFullYear()}
          </p>
        </div>
      </div>
    </div>
  );
}
