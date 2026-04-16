create extension if not exists "pgcrypto";

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  firebase_uid text not null unique,
  email text not null unique,
  display_name text,
  photo_url text,
  auth_provider text not null default 'google',
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists workspaces (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  owner_user_id uuid not null references users(id) on delete restrict,
  plan_key text not null default 'starter',
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists workspace_members (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  role text not null default 'owner',
  invited_at timestamptz,
  joined_at timestamptz,
  created_at timestamptz not null default now(),
  unique (workspace_id, user_id)
);

create table if not exists access_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete set null,
  workspace_id uuid references workspaces(id) on delete set null,
  event_type text not null,
  source text not null default 'web',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists access_events_user_id_idx on access_events (user_id, created_at desc);
create index if not exists access_events_workspace_id_idx on access_events (workspace_id, created_at desc);
