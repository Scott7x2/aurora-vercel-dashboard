alter table tickets
  add column if not exists last_staff_notification_at timestamptz,
  add column if not exists controls_message_id text;

select 'aurora-ticket-staff-controls-ok' as status;
