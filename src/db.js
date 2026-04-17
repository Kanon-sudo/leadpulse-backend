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

  create index if not exists workspace_billing_status_idx on workspace_billing (stripe_status, current_period_end desc);
  create index if not exists stripe_event_log_workspace_id_idx on stripe_event_log (workspace_id, created_at desc);
`;

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
      insert into workspaces (slug, name, owner_user_id)
      values ($1, $2, $3)
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

export async function syncUserSession(session) {
  const client = await pool.connect();

  try {
    await client.query("begin");

    const userResult = await client.query(
      `
        insert into users (firebase_uid, email, display_name, photo_url, auth_provider, last_login_at, updated_at)
        values ($1, $2, $3, $4, $5, now(), now())
        on conflict (firebase_uid)
        do update set
          email = excluded.email,
          display_name = excluded.display_name,
          photo_url = excluded.photo_url,
          auth_provider = excluded.auth_provider,
          last_login_at = excluded.last_login_at,
          updated_at = excluded.updated_at
        returning id, firebase_uid, email, display_name, photo_url, auth_provider, last_login_at, created_at, updated_at
      `,
      [
        session.firebaseUid,
        session.email,
        session.displayName,
        session.photoUrl,
        session.authProvider || "google",
      ]
    );

    const user = userResult.rows[0];
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

async function selectWorkspaceBillingSnapshot(workspaceId, client = pool) {
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
        wb.updated_at
      from workspaces w
      left join workspace_billing wb on wb.workspace_id = w.id
      where w.id = $1
      limit 1
    `,
    [workspaceId]
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
      await client.query(
        `
          update workspaces
          set plan_key = $2, updated_at = now()
          where id = $1
        `,
        [workspaceId, planKey]
      );
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
