"""Email sending service using Resend API."""
import os
import asyncio
import logging
import resend

logger = logging.getLogger(__name__)

ADMIN_NOTIFY_EMAIL = "mail@radhyafinance.com"


def _build_otp_html(otp: str, name: str | None, purpose: str = "login") -> str:
    safe_name = (name or "there").strip() or "there"
    if purpose == "forgot_password":
        subject_line = "Password Reset Request"
        body_line = "Use the One-Time Password (OTP) below to reset your Radhya HR account password. This code is valid for <strong>10 minutes</strong>."
        note_line = "If you did not request a password reset, ignore this email — your account is safe."
    else:
        subject_line = "HR Login Verification"
        body_line = "Use the One-Time Password (OTP) below to sign in to the HR portal. This code is valid for <strong>10 minutes</strong>."
        note_line = "If you did not request this code, ignore this email — your account is safe."

    return f"""\
<!DOCTYPE html>
<html>
  <body style="margin:0;padding:0;background:#F8FAFC;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F8FAFC;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border:1px solid #E2E8F0;border-radius:12px;overflow:hidden;">
            <tr>
              <td style="background:#1E2A47;padding:24px 28px;color:#ffffff;">
                <p style="margin:0;font-size:13px;letter-spacing:1px;color:#E85B1E;font-weight:600;text-transform:uppercase;">Radhya Micro Finance</p>
                <h1 style="margin:6px 0 0 0;font-size:22px;color:#ffffff;">{subject_line}</h1>
              </td>
            </tr>
            <tr>
              <td style="padding:28px;color:#0F172A;">
                <p style="margin:0 0 16px 0;font-size:15px;">Hi {safe_name},</p>
                <p style="margin:0 0 18px 0;font-size:15px;line-height:1.55;color:#334155;">{body_line}</p>
                <div style="text-align:center;margin:24px 0;">
                  <div style="display:inline-block;background:#FFF7ED;border:2px dashed #E85B1E;border-radius:12px;padding:18px 32px;">
                    <p style="margin:0;font-size:11px;color:#7C2D12;letter-spacing:2px;font-weight:700;text-transform:uppercase;">Your OTP</p>
                    <p style="margin:8px 0 0 0;font-size:36px;letter-spacing:10px;color:#E85B1E;font-weight:800;font-family:'Courier New',monospace;">{otp}</p>
                  </div>
                </div>
                <p style="margin:0 0 12px 0;font-size:13px;line-height:1.55;color:#64748B;">{note_line}</p>
                <p style="margin:0;font-size:13px;line-height:1.55;color:#64748B;">Never share this OTP with anyone. The HR team will never ask for it.</p>
              </td>
            </tr>
            <tr>
              <td style="background:#F8FAFC;padding:18px 28px;border-top:1px solid #E2E8F0;color:#94A3B8;font-size:12px;text-align:center;">
                Radhya Micro Finance Private Limited &middot; Moradabad, UP
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>
"""


def _build_admin_reset_html(emp_id: str, emp_name: str, reset_by: str) -> str:
    return f"""\
<!DOCTYPE html>
<html>
  <body style="margin:0;padding:0;background:#F8FAFC;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F8FAFC;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border:1px solid #E2E8F0;border-radius:12px;overflow:hidden;">
            <tr>
              <td style="background:#1E2A47;padding:24px 28px;color:#ffffff;">
                <p style="margin:0;font-size:13px;letter-spacing:1px;color:#E85B1E;font-weight:600;text-transform:uppercase;">Radhya Micro Finance HR</p>
                <h1 style="margin:6px 0 0 0;font-size:22px;color:#ffffff;">Password Reset Notification</h1>
              </td>
            </tr>
            <tr>
              <td style="padding:28px;color:#0F172A;">
                <p style="margin:0 0 16px 0;font-size:15px;">An employee password has been reset by HR Admin.</p>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F8FAFC;border:1px solid #E2E8F0;border-radius:8px;padding:4px;">
                  <tr>
                    <td style="padding:10px 14px;border-bottom:1px solid #E2E8F0;">
                      <span style="font-size:12px;color:#64748B;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">Employee ID</span><br/>
                      <span style="font-size:15px;color:#0F172A;font-family:'Courier New',monospace;font-weight:700;">{emp_id}</span>
                    </td>
                  </tr>
                  <tr>
                    <td style="padding:10px 14px;border-bottom:1px solid #E2E8F0;">
                      <span style="font-size:12px;color:#64748B;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">Employee Name</span><br/>
                      <span style="font-size:15px;color:#0F172A;font-weight:600;">{emp_name}</span>
                    </td>
                  </tr>
                  <tr>
                    <td style="padding:10px 14px;">
                      <span style="font-size:12px;color:#64748B;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">Reset By</span><br/>
                      <span style="font-size:15px;color:#0F172A;">{reset_by}</span>
                    </td>
                  </tr>
                </table>
                <p style="margin:18px 0 0 0;font-size:13px;color:#64748B;line-height:1.55;">
                  The employee will be prompted to change their password on their next login.
                  Please share the temporary password with them through a secure channel.
                </p>
              </td>
            </tr>
            <tr>
              <td style="background:#F8FAFC;padding:18px 28px;border-top:1px solid #E2E8F0;color:#94A3B8;font-size:12px;text-align:center;">
                Radhya Micro Finance Private Limited &middot; Moradabad, UP
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>
"""


async def send_otp_email(to_email: str, otp: str, name: str | None = None) -> dict:
    """Send a 6-digit OTP code to the user's email (login verification)."""
    return await _send_otp(to_email, otp, name, purpose="login")


async def send_forgot_password_otp_email(to_email: str, otp: str, name: str | None = None) -> dict:
    """Send a 6-digit OTP code to the user's email for password reset."""
    return await _send_otp(to_email, otp, name, purpose="forgot_password")


async def _send_otp(to_email: str, otp: str, name: str | None, purpose: str) -> dict:
    api_key = os.environ.get("RESEND_API_KEY")
    sender = os.environ.get("SENDER_EMAIL")
    if not api_key:
        raise RuntimeError("RESEND_API_KEY not configured on server")
    if not sender:
        raise RuntimeError("SENDER_EMAIL not configured on server")
    resend.api_key = api_key
    subject = "Reset your Radhya HR password" if purpose == "forgot_password" else f"Your Radhya HR login OTP: {otp}"
    params = {
        "from": f"Radhya HR <{sender}>",
        "to": [to_email],
        "subject": subject,
        "html": _build_otp_html(otp, name, purpose=purpose),
    }
    try:
        result = await asyncio.to_thread(resend.Emails.send, params)
        logger.info(f"OTP email ({purpose}) sent to {to_email}, id={result.get('id')}")
        return result
    except Exception as e:
        logger.error(f"OTP email send failed for {to_email}: {e}")
        raise


async def send_admin_reset_notification(emp_id: str, emp_name: str, reset_by: str) -> dict:
    """Notify the admin inbox when an employee's password is reset."""
    api_key = os.environ.get("RESEND_API_KEY")
    sender = os.environ.get("SENDER_EMAIL")
    if not api_key:
        raise RuntimeError("RESEND_API_KEY not configured on server")
    if not sender:
        raise RuntimeError("SENDER_EMAIL not configured on server")
    resend.api_key = api_key
    params = {
        "from": f"Radhya HR <{sender}>",
        "to": [ADMIN_NOTIFY_EMAIL],
        "subject": f"Password Reset: {emp_id} — {emp_name}",
        "html": _build_admin_reset_html(emp_id, emp_name, reset_by),
    }
    try:
        result = await asyncio.to_thread(resend.Emails.send, params)
        logger.info(f"Admin reset notification sent for {emp_id}, id={result.get('id')}")
        return result
    except Exception as e:
        logger.error(f"Admin reset notification failed for {emp_id}: {e}")
        raise
