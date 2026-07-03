import React, { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";
import API from "../utils/api";
import { Eye, EyeOff, LogIn, KeyRound, Send, ArrowLeft, ShieldAlert, CheckCircle } from "lucide-react";

// Password strength: min 8 chars, 1 uppercase, 1 number
const PWD_RE = /^(?=.*[A-Z])(?=.*\d).{8,}$/;
const PWD_HINT = "at least 8 characters, 1 uppercase letter, and 1 number";
function validatePwd(p) {
  if (!PWD_RE.test(p)) return `Password must have ${PWD_HINT}.`;
  return "";
}

// mode: "password" | "forgot-request" | "forgot-verify" | "force-change"

export default function Login() {
  const [mode, setMode] = useState("password");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [otp, setOtp] = useState("");
  const [newPwd, setNewPwd] = useState("");
  const [confirmPwd, setConfirmPwd] = useState("");
  const [maskedEmail, setMaskedEmail] = useState("");
  const [resendIn, setResendIn] = useState(0);
  const [showPass, setShowPass] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const { login, loginWithToken } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (resendIn <= 0) return;
    const t = setInterval(() => setResendIn((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(t);
  }, [resendIn]);

  const reset = () => { setError(""); setInfo(""); };

  /* ── Password login ── */
  const handlePasswordLogin = async (e) => {
    e.preventDefault();
    reset();
    setLoading(true);
    try {
      const result = await login(username.trim(), password);
      if (result.must_change_password) {
        setMode("force-change");
      } else {
        navigate("/dashboard");
      }
    } catch (err) {
      const d = err.response?.data?.detail;
      setError(typeof d === "string" ? d : "Invalid username or password");
    } finally {
      setLoading(false);
    }
  };

  /* ── Forgot password — step 1: request OTP ── */
  const handleForgotRequest = async (e) => {
    if (e) e.preventDefault();
    reset();
    if (!username.trim()) { setError("Please enter your Username / Employee ID."); return; }
    setLoading(true);
    try {
      const res = await API.post("/auth/forgot-password/request", { username: username.trim() });
      setMaskedEmail(res.data.email_masked || "");
      setMode("forgot-verify");
      setResendIn(60);
    } catch (err) {
      const d = err.response?.data?.detail;
      setError(typeof d === "string" ? d : "Could not send OTP. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  /* ── Forgot password — step 2: verify OTP + set new password ── */
  const handleForgotVerify = async (e) => {
    e.preventDefault();
    reset();
    const pwdErr = validatePwd(newPwd);
    if (pwdErr) { setError(pwdErr); return; }
    if (newPwd !== confirmPwd) { setError("Passwords do not match."); return; }
    setLoading(true);
    try {
      await API.post("/auth/forgot-password/verify", {
        username: username.trim(),
        otp: otp.trim(),
        new_password: newPwd,
      });
      setInfo("Password reset successful! You can now log in with your new password.");
      setMode("password");
      setOtp(""); setNewPwd(""); setConfirmPwd("");
    } catch (err) {
      const d = err.response?.data?.detail;
      setError(typeof d === "string" ? d : "OTP verification failed.");
    } finally {
      setLoading(false);
    }
  };

  /* ── Forced password change (after admin reset) ── */
  const handleForceChange = async (e) => {
    e.preventDefault();
    reset();
    const pwdErr = validatePwd(newPwd);
    if (pwdErr) { setError(pwdErr); return; }
    if (newPwd !== confirmPwd) { setError("Passwords do not match."); return; }
    setLoading(true);
    try {
      await API.post("/auth/forced-password-change", { new_password: newPwd });
      // Now fetch user data and complete login
      const meRes = await API.get("/auth/me");
      loginWithToken(localStorage.getItem("auth_token"), meRes.data);
      navigate("/dashboard");
    } catch (err) {
      const d = err.response?.data?.detail;
      setError(typeof d === "string" ? d : "Could not update password.");
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

          {/* ── Password Login ── */}
          {mode === "password" && (
            <>
              <h2 className="text-3xl font-bold text-[#1E2A47] mb-1" style={{ fontFamily: "'Outfit', sans-serif" }}>Welcome back</h2>
              <p className="text-slate-500 mb-8">Sign in to your HR account</p>

              {info && (
                <div className="flex items-start gap-2 mb-5 bg-green-50 border border-green-200 text-green-700 px-4 py-3 rounded-lg text-sm" data-testid="success-banner">
                  <CheckCircle size={16} className="mt-0.5 flex-shrink-0" /> {info}
                </div>
              )}

              <form onSubmit={handlePasswordLogin} className="space-y-5" data-testid="password-login-form">
                <div>
                  <label className="block text-sm font-semibold text-[#0F172A] mb-1.5">Username</label>
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
                  <div className="text-right mt-1">
                    <button type="button" onClick={() => { reset(); setMode("forgot-request"); }}
                      data-testid="forgot-password-link"
                      className="text-xs text-[#E85B1E] hover:underline">
                      Forgot password?
                    </button>
                  </div>
                </div>

                {error && <div data-testid="login-error" className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">{error}</div>}

                <button type="submit" disabled={loading} data-testid="login-submit-button"
                  className="w-full bg-[#E85B1E] hover:bg-[#D04A15] text-white font-semibold py-3 px-6 rounded-lg flex items-center justify-center gap-2 transition-colors disabled:opacity-60 disabled:cursor-not-allowed">
                  {loading ? <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" /> : <><LogIn size={18} /> Sign In</>}
                </button>
              </form>
            </>
          )}

          {/* ── Forgot Password Step 1: Enter username ── */}
          {mode === "forgot-request" && (
            <>
              <button type="button" onClick={() => { setMode("password"); reset(); }}
                className="text-xs text-slate-500 hover:text-slate-700 flex items-center gap-1 mb-6" data-testid="back-to-login-btn">
                <ArrowLeft size={12} /> Back to sign in
              </button>
              <h2 className="text-2xl font-bold text-[#1E2A47] mb-1" style={{ fontFamily: "'Outfit', sans-serif" }}>Forgot password?</h2>
              <p className="text-slate-500 mb-8 text-sm">Enter your username and we'll send an OTP to your registered email address.</p>
              <form onSubmit={handleForgotRequest} className="space-y-5" data-testid="forgot-request-form">
                <div>
                  <label className="block text-sm font-semibold text-[#0F172A] mb-1.5">Username / Employee ID</label>
                  <input type="text" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="RMF0001 or admin" required
                    autoCapitalize="none" autoCorrect="off" spellCheck="false" data-testid="forgot-username-input"
                    className="w-full border border-slate-300 rounded-lg px-4 py-3 text-[#0F172A] focus:ring-2 focus:ring-[#E85B1E] focus:border-transparent outline-none transition-all text-sm" />
                  <p className="text-xs text-slate-500 mt-1">A 6-digit code will be sent to the email on your HR record.</p>
                </div>
                {error && <div data-testid="forgot-error" className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">{error}</div>}
                <button type="submit" disabled={loading} data-testid="send-otp-btn"
                  className="w-full bg-[#E85B1E] hover:bg-[#D04A15] text-white font-semibold py-3 px-6 rounded-lg flex items-center justify-center gap-2 transition-colors disabled:opacity-60">
                  {loading ? <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" /> : <><Send size={18} /> Send OTP</>}
                </button>
              </form>
            </>
          )}

          {/* ── Forgot Password Step 2: OTP + new password ── */}
          {mode === "forgot-verify" && (
            <>
              <button type="button" onClick={() => { setMode("forgot-request"); setOtp(""); reset(); }}
                className="text-xs text-slate-500 hover:text-slate-700 flex items-center gap-1 mb-6" data-testid="back-to-forgot-btn">
                <ArrowLeft size={12} /> Back
              </button>
              <h2 className="text-2xl font-bold text-[#1E2A47] mb-1" style={{ fontFamily: "'Outfit', sans-serif" }}>Reset password</h2>
              <p className="text-slate-500 mb-6 text-sm">
                A 6-digit code was sent to <strong className="font-mono text-[#1E2A47]">{maskedEmail}</strong>. Enter it below along with your new password.
              </p>
              <form onSubmit={handleForgotVerify} className="space-y-5" data-testid="forgot-verify-form">
                <div>
                  <label className="block text-sm font-semibold text-[#0F172A] mb-1.5">6-digit OTP</label>
                  <input type="text" inputMode="numeric" pattern="[0-9]*" maxLength={6} value={otp}
                    onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))} placeholder="000000" required
                    data-testid="forgot-otp-input" autoFocus
                    className="w-full border border-slate-300 rounded-lg px-4 py-3 text-center text-2xl tracking-[0.5em] font-mono text-[#0F172A] focus:ring-2 focus:ring-[#E85B1E] focus:border-transparent outline-none transition-all" />
                </div>
                <div>
                  <label className="block text-sm font-semibold text-[#0F172A] mb-1.5">New Password</label>
                  <div className="relative">
                    <input type={showNew ? "text" : "password"} value={newPwd} onChange={(e) => setNewPwd(e.target.value)}
                      placeholder="Min 8 chars, 1 uppercase, 1 number" required data-testid="new-password-input"
                      className="w-full border border-slate-300 rounded-lg px-4 py-3 pr-12 text-[#0F172A] focus:ring-2 focus:ring-[#E85B1E] focus:border-transparent outline-none transition-all text-sm" />
                    <button type="button" onClick={() => setShowNew(!showNew)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
                      {showNew ? <EyeOff size={18} /> : <Eye size={18} />}
                    </button>
                  </div>
                  {newPwd && <p className={`text-xs mt-1 ${PWD_RE.test(newPwd) ? "text-green-600" : "text-amber-600"}`}>{PWD_RE.test(newPwd) ? "Looks good" : `Needs: ${PWD_HINT}`}</p>}
                </div>
                <div>
                  <label className="block text-sm font-semibold text-[#0F172A] mb-1.5">Confirm New Password</label>
                  <input type="password" value={confirmPwd} onChange={(e) => setConfirmPwd(e.target.value)}
                    placeholder="Re-enter new password" required data-testid="confirm-password-input"
                    className="w-full border border-slate-300 rounded-lg px-4 py-3 text-[#0F172A] focus:ring-2 focus:ring-[#E85B1E] focus:border-transparent outline-none transition-all text-sm" />
                </div>

                {error && <div data-testid="reset-error" className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">{error}</div>}

                <button type="submit" disabled={loading || otp.length < 6} data-testid="reset-password-btn"
                  className="w-full bg-[#E85B1E] hover:bg-[#D04A15] text-white font-semibold py-3 px-6 rounded-lg flex items-center justify-center gap-2 transition-colors disabled:opacity-60 disabled:cursor-not-allowed">
                  {loading ? <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" /> : <><KeyRound size={18} /> Reset Password</>}
                </button>

                <button type="button" onClick={handleForgotRequest} disabled={resendIn > 0 || loading} data-testid="resend-otp-btn"
                  className="w-full text-sm text-[#E85B1E] hover:underline disabled:text-slate-400 disabled:no-underline disabled:cursor-not-allowed">
                  {resendIn > 0 ? `Resend code in ${resendIn}s` : "Resend OTP"}
                </button>
              </form>
            </>
          )}

          {/* ── Forced Password Change (after admin reset) ── */}
          {mode === "force-change" && (
            <>
              <div className="flex items-start gap-3 mb-6 p-4 bg-amber-50 border border-amber-200 rounded-xl">
                <ShieldAlert size={20} className="text-amber-600 flex-shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-semibold text-amber-800">Password change required</p>
                  <p className="text-xs text-amber-700 mt-0.5">Your password was reset by an administrator. Please set a new password to continue.</p>
                </div>
              </div>
              <h2 className="text-2xl font-bold text-[#1E2A47] mb-1" style={{ fontFamily: "'Outfit', sans-serif" }}>Set new password</h2>
              <p className="text-slate-500 mb-8 text-sm">Choose a strong password that you haven't used before.</p>
              <form onSubmit={handleForceChange} className="space-y-5" data-testid="force-change-form">
                <div>
                  <label className="block text-sm font-semibold text-[#0F172A] mb-1.5">New Password</label>
                  <div className="relative">
                    <input type={showNew ? "text" : "password"} value={newPwd} onChange={(e) => setNewPwd(e.target.value)}
                      placeholder="Min 8 chars, 1 uppercase, 1 number" required data-testid="force-new-password-input" autoFocus
                      className="w-full border border-slate-300 rounded-lg px-4 py-3 pr-12 text-[#0F172A] focus:ring-2 focus:ring-[#E85B1E] focus:border-transparent outline-none transition-all text-sm" />
                    <button type="button" onClick={() => setShowNew(!showNew)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
                      {showNew ? <EyeOff size={18} /> : <Eye size={18} />}
                    </button>
                  </div>
                  {newPwd && <p className={`text-xs mt-1 ${PWD_RE.test(newPwd) ? "text-green-600" : "text-amber-600"}`}>{PWD_RE.test(newPwd) ? "Looks good" : `Needs: ${PWD_HINT}`}</p>}
                </div>
                <div>
                  <label className="block text-sm font-semibold text-[#0F172A] mb-1.5">Confirm New Password</label>
                  <input type="password" value={confirmPwd} onChange={(e) => setConfirmPwd(e.target.value)}
                    placeholder="Re-enter new password" required data-testid="force-confirm-password-input"
                    className="w-full border border-slate-300 rounded-lg px-4 py-3 text-[#0F172A] focus:ring-2 focus:ring-[#E85B1E] focus:border-transparent outline-none transition-all text-sm" />
                </div>

                {error && <div data-testid="force-error" className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">{error}</div>}

                <button type="submit" disabled={loading} data-testid="force-change-submit"
                  className="w-full bg-[#E85B1E] hover:bg-[#D04A15] text-white font-semibold py-3 px-6 rounded-lg flex items-center justify-center gap-2 transition-colors disabled:opacity-60">
                  {loading ? <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" /> : <><KeyRound size={18} /> Set Password & Continue</>}
                </button>
              </form>
            </>
          )}

          <p className="mt-8 text-center text-xs text-slate-400">
            Radhya Micro Finance Private Limited &copy; {new Date().getFullYear()}
          </p>
        </div>
      </div>
    </div>
  );
}
