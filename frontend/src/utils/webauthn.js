/**
 * Helpers for WebAuthn ceremony — wraps @simplewebauthn/browser and our API.
 */
import API from "../utils/api";
import { startRegistration, startAuthentication, browserSupportsWebAuthn } from "@simplewebauthn/browser";

export const isWebAuthnSupported = () => browserSupportsWebAuthn();

/**
 * Register the current device for the logged-in user.
 * Throws on error; returns success message on completion.
 */
export async function registerWebAuthnDevice(friendlyName) {
  if (!isWebAuthnSupported()) throw new Error("This browser does not support biometric login.");
  const opts = (await API.post("/auth/webauthn/register/begin")).data;
  let credential;
  try {
    credential = await startRegistration({ optionsJSON: opts });
  } catch (e) {
    if (e.name === "InvalidStateError") throw new Error("This device is already registered.");
    if (e.name === "NotAllowedError") throw new Error("Cancelled or no biometric available on this device.");
    throw new Error(e.message || "Registration failed");
  }
  const res = await API.post("/auth/webauthn/register/complete", {
    credential,
    friendly_name: friendlyName || "Device",
  });
  return res.data;
}

/**
 * Authenticate the user via biometric. Returns { access_token, user } on success.
 */
export async function authenticateWithBiometric(username) {
  if (!isWebAuthnSupported()) throw new Error("This browser does not support biometric login.");
  if (!username) throw new Error("Please enter your username first.");
  const opts = (await API.post("/auth/webauthn/authenticate/begin", { username })).data;
  let credential;
  try {
    credential = await startAuthentication({ optionsJSON: opts });
  } catch (e) {
    if (e.name === "NotAllowedError") throw new Error("Cancelled or biometric verification failed.");
    throw new Error(e.message || "Authentication failed");
  }
  const res = await API.post("/auth/webauthn/authenticate/complete", { username, credential });
  return res.data;
}
