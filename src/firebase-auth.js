import { createRemoteJWKSet, jwtVerify } from "jose";

const firebaseProjectId = process.env.FIREBASE_PROJECT_ID;

if (!firebaseProjectId) {
  throw new Error("Missing required environment variable: FIREBASE_PROJECT_ID");
}

const issuer = `https://securetoken.google.com/${firebaseProjectId}`;
const audience = firebaseProjectId;
const jwks = createRemoteJWKSet(
  new URL("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com")
);

export async function verifyFirebaseIdToken(idToken) {
  if (!idToken) {
    throw new Error("Missing Firebase ID token");
  }

  const { payload } = await jwtVerify(idToken, jwks, {
    issuer,
    audience,
  });

  if (!payload.sub || !payload.email) {
    throw new Error("Firebase token is missing required claims");
  }

  const authProvider = Array.isArray(payload.firebase?.sign_in_provider)
    ? payload.firebase.sign_in_provider[0]
    : payload.firebase?.sign_in_provider || "google";

  return {
    firebaseUid: String(payload.sub),
    email: String(payload.email),
    emailVerified: Boolean(payload.email_verified),
    displayName: payload.name ? String(payload.name) : "",
    photoUrl: payload.picture ? String(payload.picture) : "",
    authProvider,
    rawClaims: payload,
  };
}
