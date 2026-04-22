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
  plan_key text not null default 'free',
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

create index if not exists access_events_user_id_idx on access_events (user_id, created_at desc);
create index if not exists access_events_workspace_id_idx on access_events (workspace_id, created_at desc);
create index if not exists workspace_billing_status_idx on workspace_billing (stripe_status, current_period_end desc);
create index if not exists stripe_event_log_workspace_id_idx on stripe_event_log (workspace_id, created_at desc);
create index if not exists workspace_credit_usage_workspace_id_idx on workspace_credit_usage_events (workspace_id, created_at desc);
create index if not exists workspace_credit_purchases_workspace_id_idx on workspace_credit_purchases (workspace_id, created_at desc);
