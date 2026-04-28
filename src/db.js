import pg from "pg";

const { Pool } = pg;

const requiredEnv = [
  "LEADPULSE_DB_HOST",
  "LEADPULSE_DB_PORT",
  "LEADPULSE_DB_NAME",
  "LEADPULSE_DB_USER",
  "LEADPULSE_DB_PASSWORD",
];

for (const key of requiredEnv) {
  if (!process.env[key]) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
}

export const pool = new Pool({
  host: process.env.LEADPULSE_DB_HOST,
  port: Number(process.env.LEADPULSE_DB_PORT),
  database: process.env.LEADPULSE_DB_NAME,
  user: process.env.LEADPULSE_DB_USER,
  password: process.env.LEADPULSE_DB_PASSWORD,
  ssl: process.env.LEADPULSE_DB_SSLMODE === "require" ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30_000,
});

let billingSchemaEnsured = false;

const billingSchemaSql = `
  alter table workspaces
    alter column plan_key set default 'free';

  create table if not exists workspace_billing (
    workspace_id uuid primary key references workspaces(id) on delete cascade,
    stripe_customer_id text unique,
    stripe_subscription_id text unique,
    stripe_price_id text,
    stripe_product_id text,
    stripe_status text not null default 'inactive',
    billing_email text,
    current_period_start timestamptz,
    current_period_end timestamptz,
    cancel_at_period_end boolean not null default false,
    trial_start timestamptz,
    trial_end timestamptz,
    raw_subscription jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  );

  create table if not exists stripe_event_log (
    event_id text primary key,
    event_type text not null,
    workspace_id uuid references workspaces(id) on delete set null,
    payload jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now()
  );

  create table if not exists workspace_credits (
    workspace_id uuid primary key references workspaces(id) on delete cascade,
    included_credits integer not null default 0,
    purchased_credits integer not null default 0,
    bonus_credits integer not null default 0,
    consumed_credits integer not null default 0,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  );

  create table if not exists workspace_credit_usage_events (
    id uuid primary key default gen_random_uuid(),
    workspace_id uuid not null references workspaces(id) on delete cascade,
    usage_key text not null unique,
    bucket_key text not null,
    credits_consumed integer not null default 0,
    payload jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now()
  );

  create table if not exists workspace_credit_purchases (
    id uuid primary key default gen_random_uuid(),
    workspace_id uuid not null references workspaces(id) on delete cascade,
    stripe_event_id text unique,
    stripe_checkout_session_id text unique,
    stripe_payment_intent_id text,
    stripe_customer_id text,
    stripe_price_id text,
    stripe_product_id text,
    plan_key text not null,
    credits_granted integer not null default 0,
    amount_total integer not null default 0,
    currency text,
    billing_email text,
    payload jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now()
  );

  create index if not exists workspace_billing_status_idx on workspace_billing (stripe_status, current_period_end desc);
  create index if not exists stripe_event_log_workspace_id_idx on stripe_event_log (workspace_id, created_at desc);
  create index if not exists workspace_credit_usage_workspace_id_idx on workspace_credit_usage_events (workspace_id, created_at desc);
  create index if not exists workspace_credit_purchases_workspace_id_idx on workspace_credit_purchases (workspace_id, created_at desc);
`;

const PLAN_CREDITS = {
  free: 0,
  starter: 5000,
  growth: 25000,
  ops: 100000,
};

const PLAN_RANK = {
  free: 0,
  starter: 1,
  growth: 2,
  ops: 3,
};

function normalizePlanKey(planKey) {
  const normalizedPlanKey = String(planKey || "").trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(PLAN_CREDITS, normalizedPlanKey) ? normalizedPlanKey : "free";
}

async function updateWorkspacePlanIfHigher(client, workspaceId, nextPlanKey) {
  const normalizedPlanKey = normalizePlanKey(nextPlanKey);

  await client.query(
    `
      update workspaces
      set plan_key = case
            when case plan_key
              when 'ops' then 3
              when 'growth' then 2
              when 'starter' then 1
              else 0
            end >= $3 then plan_key
            else $2
          end,
          updated_at = now()
      where id = $1
    `,
    [workspaceId, normalizedPlanKey, PLAN_RANK[normalizedPlanKey]]
  );
}

export async function pingDatabase() {
  const result = await pool.query(
    "select current_database() as database, current_user as user, now() as server_time"
  );
  return result.rows[0];
}

export async function ensureBillingSchema() {
  if (billingSchemaEnsured) {
    return;
  }

  await pool.query(billingSchemaSql);
  billingSchemaEnsured = true;
}

function slugifyWorkspaceName(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

async function ensureWorkspace(client, userId, seedName) {
  const existingWorkspace = await client.query(
    `
      select w.id, w.slug, w.name, w.plan_key, w.status
      from workspaces w
      join workspace_members wm on wm.workspace_id = w.id
      where wm.user_id = $1
      order by w.created_at asc
      limit 1
    `,
    [userId]
  );

  if (existingWorkspace.rows[0]) {
    return existingWorkspace.rows[0];
  }

  const baseSlug = slugifyWorkspaceName(seedName) || `workspace-${userId.slice(0, 8)}`;
  let slug = baseSlug;
  let suffix = 1;

  while (true) {
    const slugCheck = await client.query("select 1 from workspaces where slug = $1 limit 1", [slug]);
    if (!slugCheck.rows[0]) {
      break;
    }
    suffix += 1;
    slug = `${baseSlug}-${suffix}`;
  }

  const workspaceName = seedName || "Leadpulse Workspace";
  const workspaceInsert = await client.query(
    `
      insert into workspaces (slug, name, owner_user_id, plan_key)
      values ($1, $2, $3, 'free')
      returning id, slug, name, plan_key, status
    `,
    [slug, workspaceName, userId]
  );

  const workspace = workspaceInsert.rows[0];

  await client.query(
    `
      insert into workspace_members (workspace_id, user_id, role, joined_at)
      values ($1, $2, 'owner', now())
      on conflict (workspace_id, user_id)
      do update set role = excluded.role, joined_at = coalesce(workspace_members.joined_at, excluded.joined_at)
    `,
    [workspace.id, userId]
  );

  return workspace;
}

async function upsertSessionUser(client, session) {
  const firebaseUid = String(session.firebaseUid || "").trim();
  const email = String(session.email || "").trim().toLowerCase();
  const displayName = session.displayName || "";
  const photoUrl = session.photoUrl || "";
  const authProvider = session.authProvider || "google";
  const values = [firebaseUid, email, displayName, photoUrl, authProvider];
  const returningColumns = `
    id, firebase_uid, email, display_name, photo_url, auth_provider, last_login_at, created_at, updated_at
  `;

  const existing = await client.query(
    `
      select ${returningColumns}
      from users
      where firebase_uid = $1 or lower(email) = lower($2)
      order by case when firebase_uid = $1 then 0 else 1 end, created_at asc
      limit 1
      for update
    `,
    [firebaseUid, email]
  );

  if (existing.rows[0]) {
    const updateResult = await client.query(
      `
        update users
        set firebase_uid = $1,
            email = $2,
            display_name = $3,
            photo_url = $4,
            auth_provider = $5,
            last_login_at = now(),
            updated_at = now()
        where id = $6
        returning ${returningColumns}
      `,
      [...values, existing.rows[0].id]
    );

    return updateResult.rows[0];
  }

  try {
    const insertResult = await client.query(
      `
        insert into users (firebase_uid, email, display_name, photo_url, auth_provider, last_login_at, updated_at)
        values ($1, $2, $3, $4, $5, now(), now())
        returning ${returningColumns}
      `,
      values
    );

    return insertResult.rows[0];
  } catch (error) {
    if (error?.code !== "23505") {
      throw error;
    }

    const updateResult = await client.query(
      `
        update users
        set firebase_uid = $1,
            email = $2,
            display_name = $3,
            photo_url = $4,
            auth_provider = $5,
            last_login_at = now(),
            updated_at = now()
        where firebase_uid = $1 or lower(email) = lower($2)
        returning ${returningColumns}
      `,
      values
    );

    if (!updateResult.rows[0]) {
      throw error;
    }

    return updateResult.rows[0];
  }
}

export async function syncUserSession(session) {
  const client = await pool.connect();

  try {
    await client.query("begin");

    const user = await upsertSessionUser(client, session);
    const preferredWorkspaceName =
      session.displayName?.trim() ||
      `${String(session.email || "").split("@")[0] || "Leadpulse"} workspace`;
    const workspace = await ensureWorkspace(client, user.id, preferredWorkspaceName);

    await client.query(
      `
        insert into access_events (user_id, workspace_id, event_type, source, payload)
        values ($1, $2, $3, $4, $5::jsonb)
      `,
      [
        user.id,
        workspace.id,
        "login",
        session.source || "web",
        JSON.stringify({
          email: user.email,
          authProvider: user.auth_provider,
          firebaseUid: user.firebase_uid,
        }),
      ]
    );

    await client.query("commit");
    return { user, workspace };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

function mapWorkspaceBillingRow(row) {
  if (!row) {
    return {
      stripeCustomerId: "",
      stripeSubscriptionId: "",
      stripePriceId: "",
      stripeProductId: "",
      stripeStatus: "inactive",
      billingEmail: "",
      currentPeriodStart: null,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      trialStart: null,
      trialEnd: null,
      createdAt: null,
      updatedAt: null,
      rawSubscription: {},
    };
  }

  return {
    stripeCustomerId: row.stripe_customer_id || "",
    stripeSubscriptionId: row.stripe_subscription_id || "",
    stripePriceId: row.stripe_price_id || "",
    stripeProductId: row.stripe_product_id || "",
    stripeStatus: row.stripe_status || "inactive",
    billingEmail: row.billing_email || "",
    currentPeriodStart: row.current_period_start || null,
    currentPeriodEnd: row.current_period_end || null,
    cancelAtPeriodEnd: Boolean(row.cancel_at_period_end),
    trialStart: row.trial_start || null,
    trialEnd: row.trial_end || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
    rawSubscription: row.raw_subscription || {},
  };
}

function resolvePlanCredits(planKey) {
  const normalizedPlanKey = normalizePlanKey(planKey);
  return PLAN_CREDITS[normalizedPlanKey] || 0;
}

function mapWorkspaceCreditsRow(row) {
  const includedCredits = Math.max(Number(row?.included_credits || 0), 0);
  const purchasedCredits = Math.max(Number(row?.purchased_credits || 0), 0);
  const bonusCredits = Math.max(Number(row?.bonus_credits || 0), 0);
  const consumedCredits = Math.max(Number(row?.consumed_credits || 0), 0);
  const totalCredits = includedCredits + purchasedCredits + bonusCredits;
  const availableCredits = Math.max(totalCredits - consumedCredits, 0);

  return {
    includedCredits,
    purchasedCredits,
    bonusCredits,
    consumedCredits,
    totalCredits,
    availableCredits,
    createdAt: row?.credits_created_at || row?.created_at || null,
    updatedAt: row?.credits_updated_at || row?.updated_at || null,
  };
}

async function ensureWorkspaceCreditsRow(client, workspaceId, planKey) {
  await client.query(
    `
      insert into workspace_credits (workspace_id, included_credits, updated_at)
      values ($1, $2, now())
      on conflict (workspace_id) do nothing
    `,
    [workspaceId, resolvePlanCredits(planKey)]
  );
}

async function normalizeLegacyWorkspaceEntitlements(client, workspaceRow, creditsRow) {
  if (!workspaceRow) {
    return { workspaceRow, creditsRow };
  }

  const planKey = String(workspaceRow.plan_key || "").trim().toLowerCase();
  const eligiblePlanCredits = resolvePlanCredits(planKey);
  const includedCredits = Math.max(Number(creditsRow?.included_credits || 0), 0);
  const purchasedCredits = Math.max(Number(creditsRow?.purchased_credits || 0), 0);
  const bonusCredits = Math.max(Number(creditsRow?.bonus_credits || 0), 0);
  const consumedCredits = Math.max(Number(creditsRow?.consumed_credits || 0), 0);

  if (!eligiblePlanCredits || planKey === "free") {
    return { workspaceRow, creditsRow };
  }

  if (workspaceRow.stripe_price_id || workspaceRow.stripe_subscription_id) {
    return { workspaceRow, creditsRow };
  }

  if (purchasedCredits > 0 || bonusCredits > 0 || consumedCredits > 0) {
    return { workspaceRow, creditsRow };
  }

  if (includedCredits !== eligiblePlanCredits) {
    return { workspaceRow, creditsRow };
  }

  const purchaseHistory = await client.query(
    `
      select 1
      from workspace_credit_purchases
      where workspace_id = $1
      limit 1
    `,
    [workspaceRow.id]
  );

  if (purchaseHistory.rows[0]) {
    return { workspaceRow, creditsRow };
  }

  await client.query(
    `
      update workspaces
      set plan_key = 'free',
          updated_at = now()
      where id = $1
    `,
    [workspaceRow.id]
  );

  await client.query(
    `
      update workspace_credits
      set included_credits = 0,
          updated_at = now()
      where workspace_id = $1
    `,
    [workspaceRow.id]
  );

  return {
    workspaceRow: {
      ...workspaceRow,
      plan_key: "free",
    },
    creditsRow: {
      ...creditsRow,
      included_credits: 0,
    },
  };
}

async function selectWorkspaceBillingSnapshot(workspaceId, client = pool) {
  await ensureBillingSchema();
  const result = await client.query(
    `
      select
        w.id,
        w.slug,
        w.name,
        w.plan_key,
        w.status,
        wb.stripe_customer_id,
        wb.stripe_subscription_id,
        wb.stripe_price_id,
        wb.stripe_product_id,
        wb.stripe_status,
        wb.billing_email,
        wb.current_period_start,
        wb.current_period_end,
        wb.cancel_at_period_end,
        wb.trial_start,
        wb.trial_end,
        wb.raw_subscription,
        wb.created_at,
        wb.updated_at,
        wc.included_credits,
        wc.purchased_credits,
        wc.bonus_credits,
        wc.consumed_credits,
        wc.created_at as credits_created_at,
        wc.updated_at as credits_updated_at
      from workspaces w
      left join workspace_billing wb on wb.workspace_id = w.id
      left join workspace_credits wc on wc.workspace_id = w.id
      where w.id = $1
      limit 1
    `,
    [workspaceId]
  );

  const row = result.rows[0];
  if (!row) {
    return null;
  }

  await ensureWorkspaceCreditsRow(client, row.id, row.plan_key);
  const creditsResult = await client.query(
    `
      select included_credits, purchased_credits, bonus_credits, consumed_credits, created_at, updated_at
      from workspace_credits
      where workspace_id = $1
      limit 1
    `,
    [workspaceId]
  );
  const normalized = await normalizeLegacyWorkspaceEntitlements(client, row, creditsResult.rows[0]);

  return {
    workspace: {
      id: normalized.workspaceRow.id,
      slug: normalized.workspaceRow.slug,
      name: normalized.workspaceRow.name,
      planKey: normalized.workspaceRow.plan_key,
      status: normalized.workspaceRow.status,
    },
    billing: mapWorkspaceBillingRow(normalized.workspaceRow),
    credits: mapWorkspaceCreditsRow(normalized.creditsRow),
  };
}

export async function getWorkspaceBillingSnapshot(workspaceId) {
  return selectWorkspaceBillingSnapshot(workspaceId);
}

export async function upsertWorkspaceBillingCustomer({ workspaceId, stripeCustomerId, billingEmail = "" }) {
  await pool.query(
    `
      insert into workspace_billing (workspace_id, stripe_customer_id, billing_email, updated_at)
      values ($1, $2, $3, now())
      on conflict (workspace_id)
      do update set
        stripe_customer_id = excluded.stripe_customer_id,
        billing_email = coalesce(excluded.billing_email, workspace_billing.billing_email),
        updated_at = now()
    `,
    [workspaceId, stripeCustomerId, billingEmail || null]
  );

  return selectWorkspaceBillingSnapshot(workspaceId);
}

export async function upsertWorkspaceBillingSubscription({
  workspaceId,
  stripeCustomerId = "",
  stripeSubscriptionId = "",
  stripePriceId = "",
  stripeProductId = "",
  stripeStatus = "inactive",
  billingEmail = "",
  currentPeriodStart = null,
  currentPeriodEnd = null,
  cancelAtPeriodEnd = false,
  trialStart = null,
  trialEnd = null,
  rawSubscription = {},
  planKey = "",
}) {
  const client = await pool.connect();

  try {
    await client.query("begin");

    await client.query(
      `
        insert into workspace_billing (
          workspace_id,
          stripe_customer_id,
          stripe_subscription_id,
          stripe_price_id,
          stripe_product_id,
          stripe_status,
          billing_email,
          current_period_start,
          current_period_end,
          cancel_at_period_end,
          trial_start,
          trial_end,
          raw_subscription,
          updated_at
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, now())
        on conflict (workspace_id)
        do update set
          stripe_customer_id = coalesce(excluded.stripe_customer_id, workspace_billing.stripe_customer_id),
          stripe_subscription_id = excluded.stripe_subscription_id,
          stripe_price_id = excluded.stripe_price_id,
          stripe_product_id = excluded.stripe_product_id,
          stripe_status = excluded.stripe_status,
          billing_email = coalesce(excluded.billing_email, workspace_billing.billing_email),
          current_period_start = excluded.current_period_start,
          current_period_end = excluded.current_period_end,
          cancel_at_period_end = excluded.cancel_at_period_end,
          trial_start = excluded.trial_start,
          trial_end = excluded.trial_end,
          raw_subscription = excluded.raw_subscription,
          updated_at = now()
      `,
      [
        workspaceId,
        stripeCustomerId || null,
        stripeSubscriptionId || null,
        stripePriceId || null,
        stripeProductId || null,
        stripeStatus,
        billingEmail || null,
        currentPeriodStart,
        currentPeriodEnd,
        cancelAtPeriodEnd,
        trialStart,
        trialEnd,
        JSON.stringify(rawSubscription || {}),
      ]
    );

    if (planKey) {
      await updateWorkspacePlanIfHigher(client, workspaceId, planKey);
    }

    await client.query("commit");
    return selectWorkspaceBillingSnapshot(workspaceId, client);
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function findWorkspaceBillingByStripeCustomerId(stripeCustomerId) {
  const result = await pool.query(
    `
      select
        w.id,
        w.slug,
        w.name,
        w.plan_key,
        w.status,
        wb.stripe_customer_id,
        wb.stripe_subscription_id,
        wb.stripe_price_id,
        wb.stripe_product_id,
        wb.stripe_status,
        wb.billing_email,
        wb.current_period_start,
        wb.current_period_end,
        wb.cancel_at_period_end,
        wb.trial_start,
        wb.trial_end,
        wb.raw_subscription,
        wb.created_at,
        wb.updated_at
      from workspace_billing wb
      join workspaces w on w.id = wb.workspace_id
      where wb.stripe_customer_id = $1
      limit 1
    `,
    [stripeCustomerId]
  );

  const row = result.rows[0];
  if (!row) {
    return null;
  }

  return {
    workspace: {
      id: row.id,
      slug: row.slug,
      name: row.name,
      planKey: row.plan_key,
      status: row.status,
    },
    billing: mapWorkspaceBillingRow(row),
  };
}

export async function hasStripeEventBeenProcessed(eventId) {
  const result = await pool.query(
    "select 1 from stripe_event_log where event_id = $1 limit 1",
    [eventId]
  );
  return Boolean(result.rows[0]);
}

export async function logStripeEvent({ eventId, eventType, workspaceId = null, payload = {} }) {
  await pool.query(
    `
      insert into stripe_event_log (event_id, event_type, workspace_id, payload)
      values ($1, $2, $3, $4::jsonb)
      on conflict (event_id) do nothing
    `,
    [eventId, eventType, workspaceId, JSON.stringify(payload || {})]
  );
}

export async function grantWorkspaceCreditsPurchase({
  workspaceId,
  eventId = "",
  checkoutSessionId = "",
  paymentIntentId = "",
  stripeCustomerId = "",
  stripePriceId = "",
  stripeProductId = "",
  billingEmail = "",
  amountTotal = 0,
  currency = "",
  planKey = "",
  payload = {},
}) {
  const normalizedPlanKey = String(planKey || "").trim().toLowerCase();
  const creditsGranted = resolvePlanCredits(normalizedPlanKey);

  if (!workspaceId) {
    throw new Error("Missing workspaceId for credit purchase");
  }

  if (!creditsGranted) {
    throw new Error(`Unsupported plan key for credit purchase: ${normalizedPlanKey}`);
  }

  const client = await pool.connect();

  try {
    await client.query("begin");
    await ensureWorkspaceCreditsRow(client, workspaceId, "free");

    const purchaseInsert = await client.query(
      `
        insert into workspace_credit_purchases (
          workspace_id,
          stripe_event_id,
          stripe_checkout_session_id,
          stripe_payment_intent_id,
          stripe_customer_id,
          stripe_price_id,
          stripe_product_id,
          plan_key,
          credits_granted,
          amount_total,
          currency,
          billing_email,
          payload
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)
        on conflict (stripe_checkout_session_id) do nothing
        returning id
      `,
      [
        workspaceId,
        eventId || null,
        checkoutSessionId || null,
        paymentIntentId || null,
        stripeCustomerId || null,
        stripePriceId || null,
        stripeProductId || null,
        normalizedPlanKey,
        creditsGranted,
        Math.max(Number(amountTotal || 0), 0),
        currency || null,
        billingEmail || null,
        JSON.stringify(payload || {}),
      ]
    );

    if (!purchaseInsert.rows[0]) {
      await client.query("commit");
      return {
        duplicate: true,
        snapshot: await selectWorkspaceBillingSnapshot(workspaceId, client),
      };
    }

    await client.query(
      `
        update workspace_credits
        set purchased_credits = purchased_credits + $2,
            updated_at = now()
        where workspace_id = $1
      `,
      [workspaceId, creditsGranted]
    );

    await updateWorkspacePlanIfHigher(client, workspaceId, normalizedPlanKey);

    await client.query(
      `
        insert into workspace_billing (
          workspace_id,
          stripe_customer_id,
          stripe_subscription_id,
          stripe_price_id,
          stripe_product_id,
          stripe_status,
          billing_email,
          current_period_start,
          current_period_end,
          cancel_at_period_end,
          trial_start,
          trial_end,
          raw_subscription,
          updated_at
        )
        values ($1, $2, null, $3, $4, 'active', $5, null, null, false, null, null, $6::jsonb, now())
        on conflict (workspace_id)
        do update set
          stripe_customer_id = coalesce(excluded.stripe_customer_id, workspace_billing.stripe_customer_id),
          stripe_subscription_id = null,
          stripe_price_id = excluded.stripe_price_id,
          stripe_product_id = excluded.stripe_product_id,
          stripe_status = excluded.stripe_status,
          billing_email = coalesce(excluded.billing_email, workspace_billing.billing_email),
          current_period_start = null,
          current_period_end = null,
          cancel_at_period_end = false,
          trial_start = null,
          trial_end = null,
          raw_subscription = excluded.raw_subscription,
          updated_at = now()
      `,
      [
        workspaceId,
        stripeCustomerId || null,
        stripePriceId || null,
        stripeProductId || null,
        billingEmail || null,
        JSON.stringify(payload || {}),
      ]
    );

    await client.query(
      `
        insert into access_events (workspace_id, event_type, source, payload)
        values ($1, 'credits_purchased', 'stripe-webhook', $2::jsonb)
      `,
      [
        workspaceId,
        JSON.stringify({
          checkoutSessionId,
          paymentIntentId,
          planKey: normalizedPlanKey,
          creditsGranted,
          amountTotal: Math.max(Number(amountTotal || 0), 0),
          currency,
        }),
      ]
    );

    await client.query("commit");
    return {
      duplicate: false,
      snapshot: await selectWorkspaceBillingSnapshot(workspaceId, client),
    };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function consumeWorkspaceCredits({
  workspaceId,
  planKey = "",
  usageKey,
  bucketKey,
  creditsConsumed,
  payload = {},
}) {
  const normalizedCredits = Math.max(Number(creditsConsumed || 0), 0);
  const client = await pool.connect();

  try {
    await client.query("begin");
    await ensureWorkspaceCreditsRow(client, workspaceId, planKey);

    const duplicateCheck = await client.query(
      `
        select id
        from workspace_credit_usage_events
        where usage_key = $1
        limit 1
      `,
      [usageKey]
    );

    if (duplicateCheck.rows[0]) {
      await client.query("commit");
      return {
        duplicate: true,
        snapshot: await selectWorkspaceBillingSnapshot(workspaceId, client),
      };
    }

    const creditsRowResult = await client.query(
      `
        select included_credits, purchased_credits, bonus_credits, consumed_credits
        from workspace_credits
        where workspace_id = $1
        limit 1
      `,
      [workspaceId]
    );

    const creditsRow = creditsRowResult.rows[0];
    const totalCredits = Math.max(Number(creditsRow?.included_credits || 0), 0)
      + Math.max(Number(creditsRow?.purchased_credits || 0), 0)
      + Math.max(Number(creditsRow?.bonus_credits || 0), 0);
    const currentConsumed = Math.max(Number(creditsRow?.consumed_credits || 0), 0);
    const availableCredits = Math.max(totalCredits - currentConsumed, 0);

    if (normalizedCredits > availableCredits) {
      throw new Error("Insufficient credits for this workspace");
    }

    await client.query(
      `
        insert into workspace_credit_usage_events (
          workspace_id,
          usage_key,
          bucket_key,
          credits_consumed,
          payload
        )
        values ($1, $2, $3, $4, $5::jsonb)
      `,
      [workspaceId, usageKey, bucketKey, normalizedCredits, JSON.stringify(payload || {})]
    );

    if (normalizedCredits > 0) {
      await client.query(
        `
          update workspace_credits
          set consumed_credits = consumed_credits + $2,
              updated_at = now()
          where workspace_id = $1
        `,
        [workspaceId, normalizedCredits]
      );
    }

    await client.query(
      `
        insert into access_events (workspace_id, event_type, source, payload)
        values ($1, 'credits_consumed', 'web', $2::jsonb)
      `,
      [
        workspaceId,
        JSON.stringify({
          usageKey,
          bucketKey,
          creditsConsumed: normalizedCredits,
          ...payload,
        }),
      ]
    );

    await client.query("commit");
    return {
      duplicate: false,
      snapshot: await selectWorkspaceBillingSnapshot(workspaceId, client),
    };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
