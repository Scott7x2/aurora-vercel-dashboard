-- Aurora Zero: corrige bancos criados com versoes antigas do schema.
-- Seguro para rodar mais de uma vez. Nao apaga dados.

alter table bot_instances add column if not exists guild_name text not null default 'Servidor';
alter table bot_instances add column if not exists bot_name text not null default 'Aurora Sales';
alter table bot_instances add column if not exists bot_client_id text;
alter table bot_instances add column if not exists token_encrypted text;
alter table bot_instances add column if not exists enabled boolean not null default false;
alter table bot_instances add column if not exists last_seen_at timestamptz;
alter table bot_instances add column if not exists last_error text;
alter table bot_instances add column if not exists created_at timestamptz not null default now();
alter table bot_instances add column if not exists updated_at timestamptz not null default now();

alter table guild_resources add column if not exists channels jsonb not null default '[]'::jsonb;
alter table guild_resources add column if not exists roles jsonb not null default '[]'::jsonb;
alter table guild_resources add column if not exists updated_at timestamptz not null default now();

alter table bot_settings add column if not exists brand_name text not null default 'Aurora Store';
alter table bot_settings add column if not exists brand_color text not null default '#5865f2';
alter table bot_settings add column if not exists auto_role_id text;
alter table bot_settings add column if not exists verified_role_id text;
alter table bot_settings add column if not exists remove_auto_role_after_verify boolean not null default true;
alter table bot_settings add column if not exists welcome_channel_id text;
alter table bot_settings add column if not exists welcome_title text not null default 'Novo membro';
alter table bot_settings add column if not exists welcome_message text not null default 'Bem-vindo, {user}, ao {server}!';
alter table bot_settings add column if not exists auth_channel_id text;
alter table bot_settings add column if not exists auth_title text not null default 'Autenticacao';
alter table bot_settings add column if not exists auth_message text not null default 'Clique para verificar sua conta.';
alter table bot_settings add column if not exists auth_button_label text not null default 'Verificar acesso';
alter table bot_settings add column if not exists ticket_channel_id text;
alter table bot_settings add column if not exists support_role_ids jsonb not null default '[]'::jsonb;
alter table bot_settings add column if not exists ticket_title text not null default 'Atendimento';
alter table bot_settings add column if not exists ticket_message text not null default 'Precisa de ajuda? Abra um ticket.';
alter table bot_settings add column if not exists ticket_button_label text not null default 'Abrir ticket';
alter table bot_settings add column if not exists sales_channel_id text;
alter table bot_settings add column if not exists sales_title text not null default 'Vitrine';
alter table bot_settings add column if not exists sales_message text not null default 'Escolha um produto para iniciar sua compra.';
alter table bot_settings add column if not exists button_emoji text;
alter table bot_settings add column if not exists custom_emoji_id text;
alter table bot_settings add column if not exists custom_emoji_name text;
alter table bot_settings add column if not exists custom_emoji_animated boolean not null default false;
alter table bot_settings add column if not exists updated_at timestamptz not null default now();

alter table products add column if not exists price text not null default '';
alter table products add column if not exists description text;
alter table products add column if not exists image_url text;
alter table products add column if not exists active boolean not null default true;
alter table products add column if not exists created_at timestamptz not null default now();

alter table tickets add column if not exists status text not null default 'open';
alter table tickets add column if not exists created_at timestamptz not null default now();
alter table tickets add column if not exists closed_at timestamptz;

select 'Aurora Zero colunas corrigidas com sucesso' as status;
