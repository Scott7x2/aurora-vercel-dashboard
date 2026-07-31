create extension if not exists pgcrypto;

create table if not exists dashboard_sessions (
  id text primary key,
  discord_id text not null,
  username text,
  avatar text,
  access_token text not null,
  refresh_token text,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table if not exists bot_instances (
  id uuid primary key default gen_random_uuid(),
  owner_discord_id text not null,
  guild_id text not null,
  guild_name text not null default 'Servidor',
  bot_name text not null default 'Aurora Sales',
  bot_client_id text,
  token_encrypted text not null,
  enabled boolean not null default false,
  last_seen_at timestamptz,
  last_error text,
  runtime_warning text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(owner_discord_id, guild_id)
);

create table if not exists guild_resources (
  bot_instance_id uuid primary key references bot_instances(id) on delete cascade,
  channels jsonb not null default '[]'::jsonb,
  roles jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists bot_settings (
  bot_instance_id uuid primary key references bot_instances(id) on delete cascade,
  brand_name text not null default 'Aurora Store',
  brand_color text not null default '#5865f2',
  auto_role_id text,
  verified_role_id text,
  remove_auto_role_after_verify boolean not null default true,
  welcome_channel_id text,
  welcome_mode text not null default 'embed',
  welcome_color text not null default '#5865f2',
  welcome_title text not null default 'Novo membro',
  welcome_message text not null default 'Bem-vindo, {user}, ao {server}!',
  auth_channel_id text,
  auth_mode text not null default 'embed',
  auth_color text not null default '#5865f2',
  auth_title text not null default 'Autenticacao',
  auth_message text not null default 'Clique para verificar sua conta.',
  auth_button_label text not null default 'Verificar acesso',
  ticket_channel_id text,
  support_role_ids jsonb not null default '[]'::jsonb,
  ticket_mode text not null default 'embed',
  ticket_color text not null default '#5865f2',
  ticket_title text not null default 'Atendimento',
  ticket_message text not null default 'Precisa de ajuda? Abra um ticket.',
  ticket_button_label text not null default 'Abrir ticket',
  ticket_open_color text not null default '#5865f2',
  ticket_open_title text not null default 'Novo atendimento de {user}',
  ticket_open_message text not null default 'Ola {user}, obrigado por abrir um ticket.\n\nExplique aqui o que voce precisa e aguarde o suporte. {supportRoleMentions}',
  ticket_open_purchase_title text not null default 'Novo pedido de {user}',
  ticket_open_purchase_message text not null default 'ID do pedido: **gerando**\nProduto: **{product}**\nPreco: **{price}**\n\nAguarde o suporte aprovar sua compra.',
  sales_channel_id text,
  sales_mode text not null default 'embed',
  sales_color text not null default '#5865f2',
  sales_title text not null default 'Vitrine',
  sales_message text not null default 'Escolha um produto para iniciar sua compra.',
  delivery_mode text not null default 'manual',
  delivery_title text not null default 'Compra aprovada',
  delivery_message text not null default 'Ola {user}, sua compra de {product} foi aprovada. O suporte enviara sua entrega em breve.',
  delivery_color text not null default '#58e39b',
  review_channel_id text,
  review_title text not null default 'Nova avaliacao',
  review_message text not null default '{user} avaliou {product} com {stars} estrelas.',
  review_color text not null default '#ffcc4d',
  review_gif_url text,
  log_channel_id text,
  stock_warn_threshold integer not null default 3,
  button_emoji text,
  custom_emoji_id text,
  custom_emoji_name text,
  custom_emoji_animated boolean not null default false,
  updated_at timestamptz not null default now()
);

create table if not exists products (
  id bigserial primary key,
  bot_instance_id uuid not null references bot_instances(id) on delete cascade,
  name text not null,
  price text not null,
  product_type text not null default 'single',
  variations jsonb not null default '[]'::jsonb,
  stock integer,
  delivery_content text,
  low_stock_notified boolean not null default false,
  description text,
  image_url text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists payment_settings (
  bot_instance_id uuid primary key references bot_instances(id) on delete cascade,
  provider text not null default 'aurora',
  checkout_mode text not null default 'ticket',
  receiver_name text,
  public_instructions text,
  private_details_encrypted text,
  terms_text text not null default 'Ao confirmar, voce declara que revisou os produtos, valores e entende que a entrega ocorre apos aprovacao do pagamento.',
  pix_city text not null default 'SAO PAULO',
  updated_at timestamptz not null default now()
);

create table if not exists payment_orders (
  id uuid primary key default gen_random_uuid(),
  bot_instance_id uuid not null references bot_instances(id) on delete cascade,
  ticket_thread_id text,
  guild_id text not null,
  buyer_id text not null,
  product_id bigint references products(id) on delete set null,
  product_name text not null default 'Produto',
  product_variant jsonb,
  amount_text text not null default '',
  provider text not null default 'aurora',
  status text not null default 'pending',
  approved_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists tickets (
  thread_id text primary key,
  bot_instance_id uuid not null references bot_instances(id) on delete cascade,
  guild_id text not null,
  owner_id text not null,
  product_id bigint references products(id) on delete set null,
  product_variant jsonb,
  payment_order_id uuid references payment_orders(id) on delete set null,
  cart_message_id text,
  terms_message_id text,
  payment_message_id text,
  cart_total_text text,
  purchase_status text not null default 'pending',
  approved_at timestamptz,
  rating integer,
  reviewed_at timestamptz,
  status text not null default 'open',
  created_at timestamptz not null default now(),
  closed_at timestamptz
);

create table if not exists cart_items (
  id bigserial primary key,
  thread_id text not null references tickets(thread_id) on delete cascade,
  product_id bigint references products(id) on delete set null,
  product_name text not null,
  variant jsonb,
  unit_price_text text not null default '',
  quantity integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists bot_logs (
  id bigserial primary key,
  bot_instance_id uuid not null references bot_instances(id) on delete cascade,
  guild_id text,
  event_type text not null,
  actor_id text,
  target_id text,
  channel_id text,
  message text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists feature_settings (
  bot_instance_id uuid primary key references bot_instances(id) on delete cascade,
  automations jsonb not null default '{}'::jsonb,
  protect jsonb not null default '{}'::jsonb,
  cloud jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists backup_snapshots (
  id bigserial primary key,
  bot_instance_id uuid not null references bot_instances(id) on delete cascade,
  snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table dashboard_sessions enable row level security;
alter table bot_instances enable row level security;
alter table guild_resources enable row level security;
alter table bot_settings enable row level security;
alter table products enable row level security;
alter table payment_settings enable row level security;
alter table payment_orders enable row level security;
alter table tickets enable row level security;
alter table cart_items enable row level security;
alter table bot_logs enable row level security;
alter table feature_settings enable row level security;
alter table backup_snapshots enable row level security;
