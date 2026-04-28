import Stripe from "stripe";
import {
  findWorkspaceBillingByStripeCustomerId,
  grantWorkspaceCreditsPurchase,
  getWorkspaceBillingSnapshot,
  hasStripeEventBeenProcessed,
  logStripeEvent,
  upsertWorkspaceBillingCustomer,
} from "./db.js";

const stripeApiVersion = "2026-02-25.clover";
const defaultAppUrl = process.env.PUBLIC_APP_URL || "https://leadpulse.email";

let stripeClient = null;

function getStripeClient() {
  if (stripeClient) {
    return stripeClient;
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error("Missing STRIPE_SECRET_KEY");
  }

  stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY, {
    apiVersion: stripeApiVersion,
  });

  return stripeClient;
}

function normalizeBaseUrl(value) {
  return String(value || defaultAppUrl).replace(/\/+$/, "");
}

function buildAbsoluteUrl(candidate, fallbackPath) {
  const baseUrl = normalizeBaseUrl(defaultAppUrl);

  try {
    return new URL(candidate || fallbackPath, `${baseUrl}/`).toString();
  } catch {
    return new URL(fallbackPath, `${baseUrl}/`).toString();
  }
}

function appendCheckoutSessionPlaceholder(url) {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}session_id={CHECKOUT_SESSION_ID}`;
}

function getPriceCatalog() {
  return {
    starter: process.env.STRIPE_PRICE_STARTER_MONTHLY || "",
    growth: process.env.STRIPE_PRICE_GROWTH_MONTHLY || "",
    ops: process.env.STRIPE_PRICE_OPS_MONTHLY || "",
  };
}

function resolvePriceId(planKey) {
  const normalizedPlanKey = String(planKey || "").trim().toLowerCase();
  const catalog = getPriceCatalog();
  const priceId = catalog[normalizedPlanKey];

  if (!priceId) {
    throw new Error(`Missing Stripe price configuration for plan: ${normalizedPlanKey}`);
  }

  return priceId;
}

function resolvePlanKeyFromPriceId(priceId) {
  const catalog = getPriceCatalog();
  return Object.entries(catalog).find(([, candidate]) => candidate === priceId)?.[0] || "";
}

async function ensureWorkspaceStripeCustomer({ workspace, user, billing }) {
  if (billing?.stripeCustomerId) {
    return billing.stripeCustomerId;
  }

  const stripe = getStripeClient();
  const customer = await stripe.customers.create({
    email: user.email || undefined,
    name: workspace.name,
    metadata: {
      workspace_id: workspace.id,
      workspace_slug: workspace.slug,
      owner_user_id: user.id,
      plan_key: workspace.planKey,
    },
  });

  await upsertWorkspaceBillingCustomer({
    workspaceId: workspace.id,
    stripeCustomerId: customer.id,
    billingEmail: user.email || "",
  });

  return customer.id;
}

export async function getBillingState(workspaceId) {
  return getWorkspaceBillingSnapshot(workspaceId);
}

export async function createCheckoutSession({
  workspace,
  user,
  billing,
  planKey,
  successUrl = "",
  cancelUrl = "",
}) {
  const stripe = getStripeClient();
  const customerId = await ensureWorkspaceStripeCustomer({ workspace, user, billing });
  const priceId = resolvePriceId(planKey);
  const successTarget = appendCheckoutSessionPlaceholder(
    buildAbsoluteUrl(successUrl, `/pricing/?checkout=success&plan=${encodeURIComponent(planKey)}`)
  );
  const cancelTarget = buildAbsoluteUrl(
    cancelUrl,
    `/pricing/?checkout=cancelled&plan=${encodeURIComponent(planKey)}`
  );

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    customer: customerId,
    client_reference_id: workspace.id,
    allow_promotion_codes: true,
    invoice_creation: {
      enabled: true,
    },
    line_items: [
      {
        price: priceId,
        quantity: 1,
      },
    ],
    success_url: successTarget,
    cancel_url: cancelTarget,
    metadata: {
      workspace_id: workspace.id,
      workspace_slug: workspace.slug,
      plan_key: planKey,
      stripe_price_id: priceId,
      owner_user_id: user.id,
    },
    payment_intent_data: {
      metadata: {
        workspace_id: workspace.id,
        workspace_slug: workspace.slug,
        plan_key: planKey,
        stripe_price_id: priceId,
      },
    },
  });

  return {
    id: session.id,
    url: session.url,
  };
}

export async function createCustomerPortalSession({
  workspace,
  billing,
}) {
  void workspace;
  void billing;
  throw new Error("Customer portal is disabled for one-time credit packs");
}

export function verifyStripeWebhookEvent(rawBody, signature) {
  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    throw new Error("Missing STRIPE_WEBHOOK_SECRET");
  }

  if (!signature) {
    throw new Error("Missing Stripe signature");
  }

  return getStripeClient().webhooks.constructEvent(
    rawBody,
    signature,
    process.env.STRIPE_WEBHOOK_SECRET
  );
}

async function resolveWorkspaceContextFromStripeObject(stripeObject) {
  const metadataWorkspaceId =
    stripeObject?.metadata?.workspace_id
    || stripeObject?.client_reference_id
    || "";

  if (metadataWorkspaceId) {
    return getWorkspaceBillingSnapshot(metadataWorkspaceId);
  }

  const customerId =
    (typeof stripeObject?.customer === "string" ? stripeObject.customer : stripeObject?.customer?.id)
    || "";

  if (customerId) {
    return findWorkspaceBillingByStripeCustomerId(customerId);
  }

  return null;
}

async function handleCheckoutCompleted(event) {
  const session = event.data.object;
  if (session.mode !== "payment" || session.payment_status !== "paid") {
    return { workspaceId: session.client_reference_id || null, ignored: true };
  }

  const workspaceContext = await resolveWorkspaceContextFromStripeObject(session);
  if (!workspaceContext?.workspace) {
    return { workspaceId: null, ignored: true };
  }

  const planKey =
    session?.metadata?.plan_key
    || resolvePlanKeyFromPriceId(session?.metadata?.stripe_price_id)
    || workspaceContext.workspace.planKey;
  const stripeCustomerId =
    typeof session.customer === "string"
      ? session.customer
      : session.customer?.id || "";
  const paymentIntentId =
    typeof session.payment_intent === "string"
      ? session.payment_intent
      : session.payment_intent?.id || "";

  await grantWorkspaceCreditsPurchase({
    workspaceId: workspaceContext.workspace.id,
    eventId: event.id,
    checkoutSessionId: session.id || "",
    paymentIntentId,
    stripeCustomerId,
    stripePriceId: session?.metadata?.stripe_price_id || "",
    stripeProductId: "",
    billingEmail: session.customer_details?.email || workspaceContext.billing.billingEmail,
    amountTotal: Number(session.amount_total || 0),
    currency: String(session.currency || "").toLowerCase(),
    planKey,
    payload: session,
  });

  return { workspaceId: workspaceContext.workspace.id, ignored: false };
}

export async function processStripeWebhookEvent(event) {
  if (await hasStripeEventBeenProcessed(event.id)) {
    return { duplicate: true, workspaceId: null };
  }

  let outcome = { workspaceId: null, ignored: false };

  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
      outcome = await handleCheckoutCompleted(event);
      break;
    default:
      outcome = { workspaceId: null, ignored: true };
      break;
  }

  await logStripeEvent({
    eventId: event.id,
    eventType: event.type,
    workspaceId: outcome.workspaceId,
    payload: event,
  });

  return {
    duplicate: false,
    workspaceId: outcome.workspaceId,
    ignored: outcome.ignored,
  };
}
