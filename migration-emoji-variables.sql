alter table bot_settings add column if not exists button_emoji text;
alter table bot_settings add column if not exists custom_emoji_id text;
alter table bot_settings add column if not exists custom_emoji_name text;
alter table bot_settings add column if not exists custom_emoji_animated boolean not null default false;

select 'Aurora emoji/variables migration aplicada' as status;
