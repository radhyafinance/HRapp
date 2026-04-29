"""Email sending service using Resend API."""
import os
import asyncio
import logging
import resend

logger = logging.getLogger(__name__)


def _build_otp_html(otp: str, name: str | None) -> str:
    safe_name = (name or "there").strip() or "there"
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
                <h1 style="margin:6px 0 0 0;font-size:22px;color:#ffffff;">HR Login Verification</h1>
              </td>
            </tr>
            <tr>
              <td style="padding:28px;color:#0F172A;">
                <p style="margin:0 0 16px 0;font-size:15px;">Hi {safe_name},</p>
                <p style="margin:0 0 18px 0;font-size:15px;line-height:1.55;color:#334155;">
                  Use the One-Time Password (OTP) below to sign in to the HR portal. This code is valid for <strong>10 minutes</strong>.
                </p>
                <div style="text-align:center;margin:24px 0;">
                  <div style="display:inline-block;background:#FFF7ED;border:2px dashed #E85B1E;border-radius:12px;padding:18px 32px;">
                    <p style="margin:0;font-size:11px;color:#7C2D12;letter-spacing:2px;font-weight:700;text-transform:uppercase;">Your OTP</p>
                    <p style="margin:8px 0 0 0;font-size:36px;letter-spacing:10px;color:#E85B1E;font-weight:800;font-family:'Courier New',monospace;">{otp}</p>
                  </div>
                </div>
                <p style="margin:0 0 12px 0;font-size:13px;line-height:1.55;color:#64748B;">
                  If you did not request this code, ignore this email — your account is safe.
                </p>
                <p style="margin:0;font-size:13px;line-height:1.55;color:#64748B;">
                  Never share this OTP with anyone. The HR team will never ask for it.
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
    """Send a 6-digit OTP code to the user's email. Returns Resend response dict.

    Raises a generic Exception on send failure — caller decides how to surface it.
    """
    api_key = os.environ.get("RESEND_API_KEY")
    sender = os.environ.get("SENDER_EMAIL")
    if not api_key:
        raise RuntimeError("RESEND_API_KEY not configured on server")
    if not sender:
        raise RuntimeError("SENDER_EMAIL not configured on server")
    resend.api_key = api_key
    params = {
        "from": f"Radhya HR <{sender}>",
        "to": [to_email],
        "subject": f"Your Radhya HR login OTP: {otp}",
        "html": _build_otp_html(otp, name),
    }
    try:
        result = await asyncio.to_thread(resend.Emails.send, params)
        logger.info(f"OTP email sent to {to_email}, id={result.get('id')}")
        return result
    except Exception as e:
        logger.error(f"OTP email send failed for {to_email}: {e}")
        raise
