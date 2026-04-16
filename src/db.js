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

export async function pingDatabase() {
  const result = await pool.query(
    "select current_database() as database, current_user as user, now() as server_time"
  );
  return result.rows[0];
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
