alter table bot_settings add column if not exists welcome_mode text not null default 'embed';
alter table bot_settings add column if not exists welcome_color text not null default '#5865f2';
alter table bot_settings add column if not exists auth_mode text not null default 'embed';
alter table bot_settings add column if not exists auth_color text not null default '#5865f2';
alter table bot_settings add column if not exists ticket_mode text not null default 'embed';
alter table bot_settings add column if not exists ticket_color text not null default '#5865f2';
alter table bot_settings add column if not exists sales_mode text not null default 'embed';
alter table bot_settings add column if not exists sales_color text not null default '#5865f2';

select 'modos de mensagem adicionados com sucesso' as status;
