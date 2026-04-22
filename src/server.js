import http from "node:http";
import { URL } from "node:url";
import { consumeWorkspaceCredits, ensureBillingSchema, pingDatabase, syncUserSession } from "./db.js";
import { verifyFirebaseIdToken } from "./firebase-auth.js";
import {
  createCheckoutSession,
  createCustomerPortalSession,
  getBillingState,
  processStripeWebhookEvent,
  verifyStripeWebhookEvent,
} from "./billing.js";

const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 8787);

function getInternalOwnerEmails() {
  return String(process.env.LEADPULSE_INTERNAL_OWNER_EMAILS || "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

function resolveInternalAccess(email = "") {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  const isOwnerBypass = normalizedEmail
    ? getInternalOwnerEmails().includes(normalizedEmail)
    : false;

  return {
    isOwnerBypass,
    role: isOwnerBypass ? "platform_owner" : "customer",
  };
}

function json(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": process.env.CORS_ORIGIN || "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  });
  response.end(JSON.stringify(payload));
}

function getBearerToken(request) {
  const authorization = String(request.headers.authorization || "");
  if (!authorization.startsWith("Bearer ")) {
    return "";
  }
  return authorization.slice("Bearer ".length).trim();
}

async function readJsonBody(request) {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(chunk);
  }

  if (!chunks.length) {
    return {};
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(raw);
}

async function readRawBody(request) {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

async function requireSession(request) {
  const body = await readJsonBody(request);
  const idToken = getBearerToken(request) || String(body.idToken || "").trim();

  if (!idToken) {
    throw new Error("Missing idToken. Send it in Authorization: Bearer <token> or as { idToken }.");
  }

  const verifiedToken = await verifyFirebaseIdToken(idToken);
  const session = await syncUserSession({
    ...verifiedToken,
    source: String(body.source || "web"),
  });
  const internalAccess = resolveInternalAccess(verifiedToken.email || session.user?.email || "");

  return {
    body,
    session,
    internalAccess,
  };
}

const server = http.createServer(async (request, response) => {
  if (!request.url) {
    json(response, 400, { ok: false, error: "Missing URL" });
    return;
  }

  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "Access-Control-Allow-Origin": process.env.CORS_ORIGIN || "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    });
    response.end();
    return;
  }

  const url = new URL(request.url, `http://${request.headers.host}`);

  try {
    if (request.method === "GET" && url.pathname === "/health") {
      json(response, 200, {
        ok: true,
        service: "leadpulse-backend",
        environment: process.env.NODE_ENV || "development",
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/db/ping") {
      const database = await pingDatabase();
      json(response, 200, {
        ok: true,
        database,
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/auth/session") {
      const { session, internalAccess } = await requireSession(request);

      json(response, 200, {
        ok: true,
        user: session.user,
        workspace: session.workspace,
        internalAccess,
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/billing/state") {
      const idToken = getBearerToken(request);

      if (!idToken) {
        json(response, 401, {
          ok: false,
          error: "Missing Authorization: Bearer <token> header.",
        });
        return;
      }

      const verifiedToken = await verifyFirebaseIdToken(idToken);
      const session = await syncUserSession({
        ...verifiedToken,
        source: "billing-state",
      });
      const billing = await getBillingState(session.workspace.id);
      const internalAccess = resolveInternalAccess(verifiedToken.email || session.user?.email || "");

      json(response, 200, {
        ok: true,
        user: session.user,
        workspace: billing?.workspace || session.workspace,
        billing: billing?.billing || null,
        credits: billing?.credits || null,
        internalAccess,
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/billing/checkout-session") {
      const { body, session } = await requireSession(request);
      const checkout = await createCheckoutSession({
        workspace: session.workspace,
        user: session.user,
        billing: (await getBillingState(session.workspace.id))?.billing,
        planKey: String(body.planKey || "").trim().toLowerCase(),
        successUrl: String(body.successUrl || ""),
        cancelUrl: String(body.cancelUrl || ""),
      });

      json(response, 200, {
        ok: true,
        checkout,
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/billing/customer-portal") {
      const { body, session } = await requireSession(request);
      const billingSnapshot = await getBillingState(session.workspace.id);

      const portal = await createCustomerPortalSession({
        workspace: billingSnapshot?.workspace || session.workspace,
        billing: billingSnapshot?.billing,
        returnUrl: String(body.returnUrl || ""),
      });

      json(response, 200, {
        ok: true,
        portal,
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/credits/consume") {
      const { body, session, internalAccess } = await requireSession(request);
      const usageKey = String(body.usageKey || "").trim();
      const bucketKey = String(body.bucketKey || "").trim().toLowerCase();
      const creditsConsumed = Number(body.creditsConsumed || 0);

      if (!usageKey) {
        json(response, 400, { ok: false, error: "Missing usageKey" });
        return;
      }

      if (!["clean", "review", "remove"].includes(bucketKey)) {
        json(response, 400, { ok: false, error: "Invalid bucketKey" });
        return;
      }

      if (internalAccess.isOwnerBypass) {
        const billingSnapshot = await getBillingState(session.workspace.id);

        json(response, 200, {
          ok: true,
          duplicate: false,
          internalAccess,
          workspace: billingSnapshot?.workspace || session.workspace,
          billing: billingSnapshot?.billing || null,
          credits: billingSnapshot?.credits || null,
          usage: {
            skipped: true,
            reason: "owner_bypass",
            requestedCredits: Math.max(creditsConsumed, 0),
          },
        });
        return;
      }

      const outcome = await consumeWorkspaceCredits({
        workspaceId: session.workspace.id,
        planKey: session.workspace.planKey,
        usageKey,
        bucketKey,
        creditsConsumed,
        payload: {
          sourceLabel: String(body.sourceLabel || ""),
          contactsCount: Number(body.contactsCount || 0),
          format: String(body.format || ""),
        },
      });

      json(response, 200, {
        ok: true,
        duplicate: outcome.duplicate,
        internalAccess,
        workspace: outcome.snapshot?.workspace || session.workspace,
        billing: outcome.snapshot?.billing || null,
        credits: outcome.snapshot?.credits || null,
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/stripe/webhook") {
      const rawBody = await readRawBody(request);
      const signature = String(request.headers["stripe-signature"] || "");
      const event = verifyStripeWebhookEvent(rawBody, signature);
      const outcome = await processStripeWebhookEvent(event);

      json(response, 200, {
        ok: true,
        received: true,
        duplicate: outcome.duplicate,
        ignored: outcome.ignored,
      });
      return;
    }

    json(response, 404, { ok: false, error: "Not found" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown server error";
    const isAuthError = message.startsWith("Missing idToken");
    const isStripeSignatureError = message.toLowerCase().includes("signature");
    const statusCode = isAuthError ? 401 : isStripeSignatureError ? 400 : 500;

    json(response, statusCode, {
      ok: false,
      error: message,
    });
  }
});

await ensureBillingSchema();

server.listen(port, host, () => {
  console.log(`Leadpulse backend listening on http://${host}:${port}`);
});
