import Stripe from "stripe";
import {
  findWorkspaceBillingByStripeCustomerId,
  getWorkspaceBillingSnapshot,
  hasStripeEventBeenProcessed,
  logStripeEvent,
  upsertWorkspaceBillingCustomer,
  upsertWorkspaceBillingSubscription,
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

function unixSecondsToDate(value) {
  return value ? new Date(Number(value) * 1000) : null;
}

function extractSubscriptionSnapshot(subscription, billingEmail = "") {
  const primaryItem = subscription?.items?.data?.[0];
  const price = primaryItem?.price;
  const productId =
    typeof price?.product === "string"
      ? price.product
      : price?.product?.id || "";

  return {
    stripeCustomerId:
      typeof subscription.customer === "string"
        ? subscription.customer
        : subscription.customer?.id || "",
    stripeSubscriptionId: subscription.id || "",
    stripePriceId: price?.id || "",
    stripeProductId: productId,
    stripeStatus: subscription.status || "inactive",
    billingEmail,
    currentPeriodStart: unixSecondsToDate(subscription.current_period_start),
    currentPeriodEnd: unixSecondsToDate(subscription.current_period_end),
    cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end),
    trialStart: unixSecondsToDate(subscription.trial_start),
    trialEnd: unixSecondsToDate(subscription.trial_end),
    rawSubscription: subscription,
  };
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
    mode: "subscription",
    customer: customerId,
    client_reference_id: workspace.id,
    allow_promotion_codes: true,
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
      owner_user_id: user.id,
    },
    subscription_data: {
      metadata: {
        workspace_id: workspace.id,
        workspace_slug: workspace.slug,
        plan_key: planKey,
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
  returnUrl = "",
}) {
  if (!billing?.stripeCustomerId) {
    throw new Error("Workspace does not have a Stripe customer yet");
  }

  const stripe = getStripeClient();
  const session = await stripe.billingPortal.sessions.create({
    customer: billing.stripeCustomerId,
    return_url: buildAbsoluteUrl(returnUrl, `/pricing/?portal=return&workspace=${workspace.slug}`),
  });

  return {
    id: session.id,
    url: session.url,
  };
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

async function syncSubscriptionRecordToWorkspace(workspaceContext, subscription, billingEmail = "") {
  if (!workspaceContext?.workspace) {
    return null;
  }

  const snapshot = extractSubscriptionSnapshot(subscription, billingEmail);
  const planKey =
    subscription?.metadata?.plan_key
    || resolvePlanKeyFromPriceId(snapshot.stripePriceId)
    || workspaceContext.workspace.planKey;

  return upsertWorkspaceBillingSubscription({
    workspaceId: workspaceContext.workspace.id,
    planKey,
    ...snapshot,
  });
}

async function handleCheckoutCompleted(event) {
  const session = event.data.object;

  if (session.mode !== "subscription" || !session.subscription) {
    return { workspaceId: session.client_reference_id || null, ignored: true };
  }

  const workspaceContext = await resolveWorkspaceContextFromStripeObject(session);
  if (!workspaceContext?.workspace) {
    return { workspaceId: null, ignored: true };
  }

  const stripe = getStripeClient();
  const subscriptionId =
    typeof session.subscription === "string"
      ? session.subscription
      : session.subscription.id;
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);

  await syncSubscriptionRecordToWorkspace(
    workspaceContext,
    subscription,
    session.customer_details?.email || workspaceContext.billing.billingEmail
  );

  return { workspaceId: workspaceContext.workspace.id, ignored: false };
}

async function handleSubscriptionUpdated(event) {
  const subscription = event.data.object;
  const workspaceContext = await resolveWorkspaceContextFromStripeObject(subscription);

  if (!workspaceContext?.workspace) {
    return { workspaceId: null, ignored: true };
  }

  await syncSubscriptionRecordToWorkspace(
    workspaceContext,
    subscription,
    workspaceContext.billing.billingEmail
  );

  return { workspaceId: workspaceContext.workspace.id, ignored: false };
}

export async function processStripeWebhookEvent(event) {
  if (await hasStripeEventBeenProcessed(event.id)) {
    return { duplicate: true, workspaceId: null };
  }

  let outcome = { workspaceId: null, ignored: false };

  switch (event.type) {
    case "checkout.session.completed":
      outcome = await handleCheckoutCompleted(event);
      break;
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      outcome = await handleSubscriptionUpdated(event);
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
