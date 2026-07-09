/**
 * Push notifications for the Android app (Capacitor + Firebase Cloud Messaging).
 *
 * Runs ONLY inside the native app (no-op in a browser). On login it asks for
 * notification permission, registers with FCM, and sends the device token to
 * the backend (`/notifications/register-device`). The backend then pushes to
 * that token whenever create_notification() fires — so every existing in-app
 * notification also arrives as a phone notification, even when the app is closed.
 */
import { Capacitor, registerPlugin } from "@capacitor/core";
import API from "./api";

const PushNotifications = registerPlugin("PushNotifications");

let inited = false;
let lastToken = null;

function isNative() {
  try { return Capacitor.isNativePlatform(); } catch { return false; }
}

/** Call once after auth. Idempotent; no-op outside the app. */
export async function initPush() {
  if (!isNative() || inited) return;
  inited = true;
  try {
    // Send the token to our backend when FCM issues/refreshes it.
    await PushNotifications.addListener("registration", (t) => {
      const token = t && t.value;
      if (!token || token === lastToken) return;
      lastToken = token;
      API.post("/notifications/register-device", { token, platform: "android" }).catch(() => {});
    });
    await PushNotifications.addListener("registrationError", () => {});
    // Tapping a notification opens its deep link (if any).
    await PushNotifications.addListener("pushNotificationActionPerformed", (action) => {
      const link = action?.notification?.data?.link;
      if (link) {
        try { window.location.href = link; } catch { /* ignore */ }
      }
    });
    let perm = await PushNotifications.checkPermissions();
    if (perm.receive === "prompt" || perm.receive === "prompt-with-rationale") {
      perm = await PushNotifications.requestPermissions();
    }
    if (perm.receive !== "granted") return;
    await PushNotifications.register();
  } catch (e) {
    // Plugin missing (older APK) or permission flow failed — ignore silently.
  }
}
