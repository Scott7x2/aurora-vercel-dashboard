import 'dotenv/config';
import crypto from 'node:crypto';
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  PermissionFlagsBits,
  SlashCommandBuilder
} from 'discord.js';
import pg from 'pg';
import QRCode from 'qrcode';

const { Pool } = pg;
const env = (name) => String(process.env[name] || '').trim();
for (const name of ['DATABASE_URL', 'BOT_ENCRYPTION_KEY']) {
  if (!env(name)) throw new Error(`${name} nao configurada.`);
}
const pool = new Pool({ connectionString: env('DATABASE_URL'), ssl: { rejectUnauthorized: false }, max: 5 });
const key = Buffer.from(env('BOT_ENCRYPTION_KEY'), 'base64');
if (key.length !== 32) throw new Error('BOT_ENCRYPTION_KEY deve ser Base64 de 32 bytes.');
const pollInterval = Math.max(Number(env('POLL_INTERVAL_MS')) || 8000, 3000);
const fullIntentRetryInterval = Math.max(Number(env('FULL_INTENT_RETRY_MS')) || 60000, 15000);
const autoRoleAuditInterval = Math.max(Number(env('AUTOROLE_AUDIT_INTERVAL_MS')) || 120000, 30000);
const runnerName = env('RUNNER_NAME') || 'aurora-zero-runner';

const running = new Map();
const raidJoins = new Map();
const lastAutoMessageAt = new Map();
const lastBackupAt = new Map();
const commands = [
  new SlashCommandBuilder()
    .setName('painel')
    .setDescription('Publica um painel Aurora no canal desejado')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((option) => option
      .setName('tipo')
      .setDescription('Qual painel publicar')
      .setRequired(true)
      .addChoices(
        { name: 'Autenticacao', value: 'auth' },
        { name: 'Tickets', value: 'ticket' },
        { name: 'Vendas', value: 'sales' }
      ))
    .addChannelOption((option) => option
      .setName('canal')
      .setDescription('Canal que recebera o painel')
      .setRequired(true)
      .addChannelTypes(ChannelType.GuildText))
].map((command) => command.toJSON());

async function query(sql, params = []) {
  const result = await pool.query(sql, params);
  return result.rows;
}

async function one(sql, params = []) {
  return (await query(sql, params))[0] || null;
}

function decrypt(value) {
  const [iv, data, tag] = value.split('.').map((part) => Buffer.from(part, 'base64'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

function row(...items) {
  return new ActionRowBuilder().addComponents(...items);
}

function parseEmoji(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const custom = raw.match(/^<(?<animated>a?):(?<name>[a-zA-Z0-9_]+):(?<id>\d+)>$/);
  if (custom?.groups) return { name: custom.groups.name, id: custom.groups.id, animated: custom.groups.animated === 'a' };
  return { name: raw };
}

function btn(id, label, style, emojiText) {
  const button = new ButtonBuilder().setCustomId(id).setLabel(String(label || 'Abrir').slice(0, 80)).setStyle(style);
  const emoji = parseEmoji(emojiText);
  if (emoji) button.setEmoji(emoji);
  return button;
}

function validColor(value, fallback) {
  return /^#[0-9a-f]{6}$/i.test(String(value || '')) ? String(value) : fallback;
}

function embed(settings, title, description, color) {
  return new EmbedBuilder()
    .setColor(validColor(color, validColor(settings.brand_color, '#5865f2')))
    .setTitle(title || settings.brand_name || 'Aurora')
    .setDescription(description || '')
    .setFooter({ text: settings.brand_name || 'Aurora Store' });
}

function messageMode(value) {
  return value === 'simple' ? 'simple' : 'embed';
}

async function safeEphemeral(interaction, content) {
  if (!interaction?.isRepliable?.()) return;
  const payload = typeof content === 'string' ? { content } : content;
  if (interaction.deferred || interaction.replied) return interaction.editReply(payload).catch(() => interaction.followUp({ ...payload, ephemeral: true }).catch(() => null));
  return interaction.reply({ ...payload, ephemeral: true }).catch(() => null);
}

function roleName(guild, id) {
  return id ? (guild?.roles?.cache?.get(id)?.name || id) : '';
}

function channelName(guild, id) {
  return id ? (guild?.channels?.cache?.get(id)?.name || id) : '';
}

function renderTemplate(template, context = {}) {
  const settings = context.settings || {};
  const guild = context.guild || context.interaction?.guild || context.member?.guild;
  const user = context.user || context.interaction?.user || context.member?.user;
  const channel = context.channel || context.interaction?.channel;
  const supportIds = Array.isArray(settings.support_role_ids) ? settings.support_role_ids : [];
  const now = new Date();
  const vars = {
    user: user ? `<@${user.id}>` : '',
    userMention: user ? `<@${user.id}>` : '',
    userId: user?.id || '',
    username: user?.username || context.member?.displayName || '',
    server: guild?.name || '',
    guild: guild?.name || '',
    memberCount: guild?.memberCount ? String(guild.memberCount) : '',
    channel: channel ? `<#${channel.id}>` : '',
    channelMention: channel ? `<#${channel.id}>` : '',
    channelName: channel?.name || '',
    owner: guild?.ownerId ? `<@${guild.ownerId}>` : '',
    autoRole: roleName(guild, settings.auto_role_id),
    autoRoleMention: settings.auto_role_id ? `<@&${settings.auto_role_id}>` : '',
    verifiedRole: roleName(guild, settings.verified_role_id),
    verifiedRoleMention: settings.verified_role_id ? `<@&${settings.verified_role_id}>` : '',
    supportRoles: supportIds.map((id) => roleName(guild, id)).filter(Boolean).join(', '),
    supportRoleMentions: supportIds.map((id) => `<@&${id}>`).join(' '),
    welcomeChannel: channelName(guild, settings.welcome_channel_id),
    authChannel: channelName(guild, settings.auth_channel_id),
    ticketChannel: channelName(guild, settings.ticket_channel_id),
    salesChannel: channelName(guild, settings.sales_channel_id),
    product: context.product?.name || '',
    price: context.product?.price || '',
    productDescription: context.product?.description || '',
    variation: context.variant?.name || '',
    variationPrice: context.variant?.price || '',
    variationDescription: context.variant?.description || '',
    deliveryContent: context.deliveryContent || context.product?.delivery_content || '',
    stars: context.stars || '',
    ticket: context.thread ? `<#${context.thread.id}>` : '',
    ticketId: context.thread?.id || '',
    emoji: settings.button_emoji || '',
    date: now.toLocaleDateString('pt-BR'),
    time: now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
  };
  return String(template || '').replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key) => vars[key] ?? '');
}

function messagePayload(settings, options = {}) {
  const context = options.context || {};
  const title = renderTemplate(options.title || '', context);
  const description = renderTemplate(options.description || '', context);
  const components = options.components || [];
  if (messageMode(options.mode) === 'simple') {
    const content = `${title ? `**${title}**\n` : ''}${description}`.trim() || title || description || ' ';
    return { content, components };
  }
  return {
    embeds: [embed(settings, title, description, options.color)],
    components
  };
}

async function setError(id, message) {
  await query('update bot_instances set last_error=$1, last_seen_at=null, updated_at=now() where id=$2', [String(message || '').slice(0, 500), id]);
}

async function setWarning(id, message) {
  await query('update bot_instances set runtime_warning=$1, updated_at=now() where id=$2', [String(message || '').slice(0, 500), id]);
}

async function clearWarning(id) {
  await query('update bot_instances set runtime_warning=null, updated_at=now() where id=$1', [id]);
}

async function getSettings(instanceId) {
  await query('insert into bot_settings (bot_instance_id) values ($1) on conflict (bot_instance_id) do nothing', [instanceId]);
  return one('select * from bot_settings where bot_instance_id=$1', [instanceId]);
}

async function products(instanceId) {
  return query('select * from products where bot_instance_id=$1 and active=true order by created_at desc', [instanceId]);
}

async function product(instanceId, id) {
  return one('select * from products where bot_instance_id=$1 and id=$2', [instanceId, id]);
}

async function paymentSettings(instanceId) {
  return one('select * from payment_settings where bot_instance_id=$1', [instanceId]);
}

async function ensureRuntimeSchema() {
  await query(`
    alter table payment_settings
      add column if not exists terms_text text not null default 'Ao confirmar, voce declara que revisou os produtos, valores e entende que a entrega ocorre apos aprovacao do pagamento.',
      add column if not exists pix_city text not null default 'SAO PAULO'
  `);
  await query(`
    alter table tickets
      add column if not exists cart_message_id text,
      add column if not exists terms_message_id text,
      add column if not exists payment_message_id text,
      add column if not exists cart_total_text text,
      add column if not exists controls_message_id text,
      add column if not exists last_staff_notification_at timestamptz
  `);
  await query(`
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
    )
  `);
  await query(`
    create table if not exists feature_settings (
      bot_instance_id uuid primary key references bot_instances(id) on delete cascade,
      automations jsonb not null default '{}'::jsonb,
      protect jsonb not null default '{}'::jsonb,
      cloud jsonb not null default '{}'::jsonb,
      updated_at timestamptz not null default now()
    )
  `);
  await query(`
    create table if not exists backup_snapshots (
      id bigserial primary key,
      bot_instance_id uuid not null references bot_instances(id) on delete cascade,
      snapshot jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now()
    )
  `);
  await query(`
    create table if not exists member_welcome_deliveries (
      bot_instance_id uuid not null references bot_instances(id) on delete cascade,
      guild_id text not null,
      user_id text not null,
      welcomed_at timestamptz not null default now(),
      primary key (bot_instance_id, user_id)
    )
  `);
  await query('alter table feature_settings enable row level security');
  await query('alter table backup_snapshots enable row level security');
  await query('alter table member_welcome_deliveries enable row level security');
}

function featureDefaults() {
  return {
    automations: {
      auto_message_enabled: false,
      auto_message_channel_id: '',
      auto_message_text: 'Ola {server}! Confira as novidades da loja.',
      auto_message_interval_minutes: 60,
      cleanup_enabled: false,
      cleanup_bad_words: '',
      cleanup_delete_invites: false,
      lock_enabled: false,
      lock_channel_ids: [],
      invite_tracker_enabled: false,
      restock_alert_enabled: true
    },
    protect: {
      moderation_enabled: true,
      log_deleted_messages: true,
      anti_raid_enabled: false,
      anti_raid_join_limit: 5,
      anti_raid_window_seconds: 20,
      anti_raid_lockdown: false,
      anti_fake_enabled: false,
      anti_fake_min_account_days: 7,
      anti_fake_action: 'log'
    },
    cloud: {
      backup_enabled: true,
      backup_interval_hours: 24
    }
  };
}

async function getFeatures(instanceId) {
  await query('insert into feature_settings (bot_instance_id) values ($1) on conflict (bot_instance_id) do nothing', [instanceId]);
  const row = await one('select * from feature_settings where bot_instance_id=$1', [instanceId]);
  const defaults = featureDefaults();
  return {
    automations: { ...defaults.automations, ...(row?.automations || {}) },
    protect: { ...defaults.protect, ...(row?.protect || {}) },
    cloud: { ...defaults.cloud, ...(row?.cloud || {}) },
    updated_at: row?.updated_at || null
  };
}

function eventCategory(type) {
  if (/ticket/.test(type)) return 'tickets';
  if (/cart|purchase|payment|stock|review/.test(type)) return 'vendas';
  if (/auto_role|welcome|member|auth/.test(type)) return 'entrada';
  if (/message/.test(type)) return 'mensagens';
  return 'sistema';
}

function parseMoney(value) {
  const raw = String(value || '').replace(/[^\d,.-]/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.');
  const number = Number.parseFloat(raw);
  return Number.isFinite(number) ? number : 0;
}

function formatBRL(value) {
  return Number(value || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function emv(id, value) {
  const text = String(value ?? '');
  return `${id}${String(text.length).padStart(2, '0')}${text}`;
}

function crc16(payload) {
  let crc = 0xffff;
  for (let i = 0; i < payload.length; i += 1) {
    crc ^= payload.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j += 1) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

function pixPayload({ key: pixKey, amount, merchant = 'Aurora Store', city = 'SAO PAULO', txid = 'AURORA' }) {
  const keyText = String(pixKey || '').trim();
  if (!keyText) return null;
  const merchantAccount = emv('00', 'br.gov.bcb.pix') + emv('01', keyText) + emv('02', String(txid || 'AURORA').slice(0, 50));
  const base = [
    emv('00', '01'),
    emv('26', merchantAccount),
    emv('52', '0000'),
    emv('53', '986'),
    amount > 0 ? emv('54', Number(amount).toFixed(2)) : '',
    emv('58', 'BR'),
    emv('59', String(merchant || 'Aurora Store').normalize('NFD').replace(/[\u0300-\u036f]/g, '').slice(0, 25).toUpperCase()),
    emv('60', String(city || 'SAO PAULO').normalize('NFD').replace(/[\u0300-\u036f]/g, '').slice(0, 15).toUpperCase()),
    emv('62', emv('05', String(txid || 'AURORA').slice(0, 25)))
  ].join('');
  const withCrc = `${base}6304`;
  return `${withCrc}${crc16(withCrc)}`;
}

async function pixAttachment(payload) {
  const buffer = await QRCode.toBuffer(payload, { type: 'png', width: 420, margin: 2, errorCorrectionLevel: 'M' });
  return new AttachmentBuilder(buffer, { name: 'pix-aurora.png' });
}

async function logEvent(instance, settings, type, message, metadata = {}) {
  const category = metadata.category || eventCategory(type);
  await query(`
    insert into bot_logs (bot_instance_id,guild_id,event_type,actor_id,target_id,channel_id,message,metadata)
    values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
  `, [
    instance.id,
    instance.guild_id,
    type,
    metadata.actorId || null,
    metadata.targetId || null,
    metadata.channelId || null,
    String(message || '').slice(0, 800),
    JSON.stringify({ ...metadata, category })
  ]).catch(console.error);
  if (!settings?.log_channel_id) return;
  const client = running.get(instance.id)?.client;
  const channel = client ? await client.channels.fetch(settings.log_channel_id).catch(() => null) : null;
  if (!channel?.isTextBased?.()) return;
  await channel.send({
    embeds: [embed(settings, `Log ${category}: ${type}`, message || 'Evento registrado.', settings.brand_color)]
  }).catch(() => null);
}

async function createBackupSnapshot(instance) {
  const [settings, features, productRows, payment, resources] = await Promise.all([
    getSettings(instance.id),
    getFeatures(instance.id),
    query('select * from products where bot_instance_id=$1 order by created_at desc', [instance.id]),
    one('select * from payment_settings where bot_instance_id=$1', [instance.id]),
    one('select channels,roles,updated_at from guild_resources where bot_instance_id=$1', [instance.id])
  ]);
  const snapshot = {
    instance: {
      id: instance.id,
      guild_id: instance.guild_id,
      guild_name: instance.guild_name,
      bot_name: instance.bot_name,
      enabled: instance.enabled
    },
    settings,
    features,
    products: productRows,
    payment: payment ? { ...payment, private_details_encrypted: Boolean(payment.private_details_encrypted) } : null,
    resources
  };
  await query('insert into backup_snapshots (bot_instance_id,snapshot) values ($1,$2::jsonb)', [instance.id, JSON.stringify(snapshot)]);
  return snapshot;
}

async function applyChannelLocks(instance, client, settings, features, reason = 'configuracao') {
  const ids = Array.isArray(features.automations.lock_channel_ids) ? features.automations.lock_channel_ids : [];
  if (!features.automations.lock_enabled || !ids.length) return;
  const guild = client.guilds.cache.get(instance.guild_id);
  if (!guild) return;
  for (const channelId of ids) {
    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (!channel?.permissionOverwrites?.edit) continue;
    await channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: false }, { reason: `Aurora Lock: ${reason}` }).catch((error) => {
      logEvent(instance, settings, 'lock_failed', `Falha ao travar <#${channelId}>: ${error.message}`, { channelId, category: 'sistema' }).catch(console.error);
    });
  }
}

async function runAutoMessage(instance, client) {
  const settings = await getSettings(instance.id);
  const features = await getFeatures(instance.id);
  const auto = features.automations;
  if (!auto.auto_message_enabled || !auto.auto_message_channel_id) return;
  const intervalMs = Math.max(Number(auto.auto_message_interval_minutes || 60), 5) * 60 * 1000;
  const key = `${instance.id}:${auto.auto_message_channel_id}`;
  if (Date.now() - Number(lastAutoMessageAt.get(key) || 0) < intervalMs) return;
  const channel = await client.channels.fetch(auto.auto_message_channel_id).catch(() => null);
  if (!channel?.isTextBased?.()) return;
  await channel.send(messagePayload(settings, {
    mode: 'embed',
    color: settings.brand_color,
    title: settings.brand_name || 'Aurora',
    description: auto.auto_message_text || 'Confira as novidades da loja.',
    context: { settings, guild: channel.guild, channel }
  })).catch((error) => logEvent(instance, settings, 'auto_message_failed', error.message, { channelId: channel.id }).catch(console.error));
  lastAutoMessageAt.set(key, Date.now());
  await logEvent(instance, settings, 'auto_message_sent', `Mensagem automatica enviada em <#${channel.id}>`, { channelId: channel.id, category: 'sistema' });
}

async function runCloudBackup(instance) {
  const settings = await getSettings(instance.id);
  const features = await getFeatures(instance.id);
  if (!features.cloud.backup_enabled) return;
  const intervalMs = Math.max(Number(features.cloud.backup_interval_hours || 24), 1) * 60 * 60 * 1000;
  if (Date.now() - Number(lastBackupAt.get(instance.id) || 0) < intervalMs) return;
  await createBackupSnapshot(instance);
  lastBackupAt.set(instance.id, Date.now());
  await logEvent(instance, settings, 'cloud_backup_created', 'Backup automatico criado no Supabase.', { category: 'sistema' });
}

function badWordsList(value) {
  return String(value || '').split(',').map((item) => item.trim().toLowerCase()).filter(Boolean).slice(0, 80);
}

async function handleCleanupMessage(message, instance, settings, features) {
  const auto = features.automations;
  if (!auto.cleanup_enabled || message.author?.bot) return;
  const content = String(message.content || '').toLowerCase();
  const hasInvite = auto.cleanup_delete_invites && /(discord\.gg\/|discord\.com\/invite\/)/i.test(content);
  const matchedWord = badWordsList(auto.cleanup_bad_words).find((word) => content.includes(word));
  if (!hasInvite && !matchedWord) return;
  await message.delete().catch(() => null);
  await logEvent(instance, settings, 'cleanup_deleted_message', `Mensagem removida automaticamente em <#${message.channelId}>. Motivo: ${hasInvite ? 'convite' : `palavra "${matchedWord}"`}`, {
    actorId: message.author?.id,
    channelId: message.channelId,
    category: 'mensagens'
  });
}

async function handleAntiFake(member, instance, settings, features) {
  const protect = features.protect;
  if (!protect.anti_fake_enabled || member.user?.bot) return;
  const ageMs = Date.now() - member.user.createdTimestamp;
  const minMs = Number(protect.anti_fake_min_account_days || 7) * 24 * 60 * 60 * 1000;
  if (ageMs >= minMs) return;
  const message = `Anti-Fake detectou conta nova: ${member.user.tag} (${Math.floor(ageMs / 86400000)} dia(s)).`;
  await logEvent(instance, settings, 'anti_fake_detected', message, { actorId: member.id, category: 'entrada' });
  if (protect.anti_fake_action === 'kick') {
    await member.kick('Aurora Anti-Fake: conta muito nova').catch((error) => {
      logEvent(instance, settings, 'anti_fake_kick_failed', `Falha ao expulsar ${member.user.tag}: ${error.message}`, { actorId: member.id, category: 'entrada' }).catch(console.error);
    });
  }
}

async function handleAntiRaid(member, instance, client, settings, features) {
  const protect = features.protect;
  if (!protect.anti_raid_enabled || member.user?.bot) return;
  const keyName = instance.id;
  const now = Date.now();
  const windowMs = Number(protect.anti_raid_window_seconds || 20) * 1000;
  const list = (raidJoins.get(keyName) || []).filter((time) => now - time <= windowMs);
  list.push(now);
  raidJoins.set(keyName, list);
  if (list.length < Number(protect.anti_raid_join_limit || 5)) return;
  await logEvent(instance, settings, 'anti_raid_triggered', `Anti-Raid ativado: ${list.length} entradas em ${protect.anti_raid_window_seconds}s.`, {
    actorId: member.id,
    count: list.length,
    category: 'entrada'
  });
  if (protect.anti_raid_lockdown) await applyChannelLocks(instance, client, settings, features, 'anti-raid').catch(console.error);
}

async function applyAutoRole(member, instance, settings, reason = 'entrada') {
  if (!settings?.auto_role_id || member.user?.bot) return false;
  if (member.roles.cache.has(settings.auto_role_id)) return true;
  const guild = member.guild;
  const role = await guild.roles.fetch(settings.auto_role_id).catch(() => null);
  if (!role) {
    const message = `Cargo automatico nao encontrado no Discord. Atualize cargos/canais no site e selecione novamente. ID: ${settings.auto_role_id}`;
    await setWarning(instance.id, message).catch(console.error);
    await logEvent(instance, settings, 'auto_role_failed', message, {
      actorId: member.id,
      targetId: settings.auto_role_id,
      reason
    });
    return false;
  }
  const me = guild.members.me || await guild.members.fetchMe().catch(() => null);
  if (!me) {
    const message = 'Nao consegui identificar o membro do bot no servidor para aplicar o cargo automatico.';
    await setWarning(instance.id, message).catch(console.error);
    await logEvent(instance, settings, 'auto_role_failed', message, { actorId: member.id, targetId: role.id, reason });
    return false;
  }
  if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) {
    const message = 'Falha no cargo automatico: o bot nao tem permissao Gerenciar Cargos. Use o botao Adicionar bot ao servidor novamente ou ajuste as permissoes do cargo do bot.';
    await setWarning(instance.id, message).catch(console.error);
    await logEvent(instance, settings, 'auto_role_failed', message, { actorId: member.id, targetId: role.id, reason });
    return false;
  }
  if (role.managed) {
    const message = `Falha no cargo automatico: o cargo ${role.name} e gerenciado por integracao e nao pode ser aplicado manualmente.`;
    await setWarning(instance.id, message).catch(console.error);
    await logEvent(instance, settings, 'auto_role_failed', message, { actorId: member.id, targetId: role.id, reason });
    return false;
  }
  if (me.roles.highest.comparePositionTo(role) <= 0) {
    const message = `Falha no cargo automatico: mova o cargo do bot (${me.roles.highest.name}) para cima do cargo ${role.name} na hierarquia do Discord.`;
    await setWarning(instance.id, message).catch(console.error);
    await logEvent(instance, settings, 'auto_role_failed', message, { actorId: member.id, targetId: role.id, reason });
    return false;
  }
  try {
    await member.roles.add(role, `Aurora autorole: ${reason}`);
    await logEvent(instance, settings, 'auto_role_applied', `Cargo automatico ${role.name} aplicado em ${member.user.tag}`, {
      actorId: member.id,
      targetId: role.id,
      reason
    });
    return true;
  } catch (error) {
    const message = `Falha ao aplicar cargo automatico ${role.name}: ${error.message}`;
    console.error(`[${runnerName}] ${message}`);
    await setWarning(instance.id, `${message}. Verifique permissoes e hierarquia do cargo do bot.`).catch(console.error);
    await logEvent(instance, settings, 'auto_role_failed', message, { actorId: member.id, targetId: role.id, reason });
    return false;
  }
}

async function sendWelcome(member, instance, settings) {
  if (!settings?.welcome_channel_id || member.user?.bot) return false;
  const channel = await member.guild.channels.fetch(settings.welcome_channel_id).catch(() => null);
  if (!channel?.isTextBased?.()) {
    const message = `Canal de boas-vindas nao encontrado ou nao e canal de texto. Atualize cargos/canais no site e selecione novamente. ID: ${settings.welcome_channel_id}`;
    await setWarning(instance.id, message).catch(console.error);
    await logEvent(instance, settings, 'welcome_failed', message, {
      actorId: member.id,
      targetId: settings.welcome_channel_id
    });
    return false;
  }
  const me = member.guild.members.me || await member.guild.members.fetchMe().catch(() => null);
  if (me && channel.permissionsFor(me)?.has(PermissionFlagsBits.SendMessages) === false) {
    const message = `Falha ao enviar boas-vindas: o bot nao tem permissao de Enviar Mensagens no canal #${channel.name}.`;
    await setWarning(instance.id, message).catch(console.error);
    await logEvent(instance, settings, 'welcome_failed', message, {
      actorId: member.id,
      channelId: channel.id
    });
    return false;
  }
  const delivery = await one(`
    insert into member_welcome_deliveries (bot_instance_id,guild_id,user_id,welcomed_at)
    values ($1,$2,$3,now())
    on conflict (bot_instance_id,user_id) do nothing
    returning user_id
  `, [instance.id, member.guild.id, member.id]);
  if (!delivery) return true;
  try {
    await channel.send(messagePayload(settings, {
      mode: settings.welcome_mode,
      color: settings.welcome_color,
      title: settings.welcome_title,
      description: settings.welcome_message,
      context: { member, settings, channel }
    }));
    await logEvent(instance, settings, 'welcome_sent', `Boas-vindas enviada para ${member.user.tag}`, {
      actorId: member.id,
      channelId: channel.id
    });
    return true;
  } catch (error) {
    await query('delete from member_welcome_deliveries where bot_instance_id=$1 and user_id=$2', [instance.id, member.id]).catch(console.error);
    const message = `Falha ao enviar boas-vindas: ${error.message}. Verifique permissoes no canal configurado.`;
    console.error(`[${runnerName}] ${message}`);
    await setWarning(instance.id, message).catch(console.error);
    await logEvent(instance, settings, 'welcome_failed', message, {
      actorId: member.id,
      channelId: channel.id
    });
    return false;
  }
}

async function auditRecentWelcomes(instance, client) {
  const settings = await getSettings(instance.id);
  if (!settings?.welcome_channel_id) return;
  const guild = client.guilds.cache.get(instance.guild_id);
  if (!guild) return;
  const members = await guild.members.fetch().catch((error) => {
    setWarning(instance.id, `Nao consegui verificar entradas recentes: ${error.message}. Confirme o Server Members Intent.`).catch(console.error);
    return null;
  });
  if (!members) return;
  const cutoff = Date.now() - 10 * 60 * 1000;
  const recent = [...members.values()]
    .filter((member) => !member.user?.bot && Number(member.joinedTimestamp || 0) >= cutoff)
    .sort((a, b) => Number(a.joinedTimestamp || 0) - Number(b.joinedTimestamp || 0));
  for (const member of recent) await sendWelcome(member, instance, settings);
}

async function auditAutoRoles(instance, client, reason = 'auditoria automatica') {
  const settings = await getSettings(instance.id);
  if (!settings?.auto_role_id) return;
  const guild = client.guilds.cache.get(instance.guild_id);
  if (!guild) return;
  const role = await guild.roles.fetch(settings.auto_role_id).catch(() => null);
  if (!role) {
    await applyAutoRole({ guild, id: 'auditoria', user: { tag: 'auditoria', bot: false }, roles: { cache: new Map() } }, instance, settings, reason).catch(() => null);
    return;
  }
  const members = await guild.members.fetch().catch((error) => {
    const message = `Nao consegui buscar membros para auditar cargo automatico: ${error.message}. Confirme o Server Members Intent no Developer Portal.`;
    setWarning(instance.id, message).catch(console.error);
    logEvent(instance, settings, 'auto_role_audit_failed', message, { targetId: role.id }).catch(console.error);
    return null;
  });
  if (!members) return;
  let applied = 0;
  for (const member of members.values()) {
    if (member.user?.bot || member.roles.cache.has(role.id)) continue;
    if (await applyAutoRole(member, instance, settings, reason)) applied += 1;
  }
  if (applied) {
    await logEvent(instance, settings, 'auto_role_audit', `Auditoria aplicou o cargo automatico ${role.name} em ${applied} membro(s).`, {
      targetId: role.id,
      count: applied
    });
  }
}

function variationsOf(item) {
  return Array.isArray(item?.variations) ? item.variations : [];
}

function chosenPrice(item, variant = null) {
  return variant?.price || item?.price || '';
}

async function cartItems(threadId) {
  return query('select * from cart_items where thread_id=$1 order by id asc', [threadId]);
}

function cartTotal(items) {
  return items.reduce((sum, item) => sum + (parseMoney(item.unit_price_text) * Number(item.quantity || 1)), 0);
}

function cartLines(items) {
  if (!items.length) return 'Carrinho vazio.';
  return items.map((item, index) => {
    const variant = item.variant?.name ? ` — ${item.variant.name}` : '';
    const lineTotal = parseMoney(item.unit_price_text) * Number(item.quantity || 1);
    return `**${index + 1}. ${item.product_name}${variant}**\nQtd: **${item.quantity}** • Unit: **${item.unit_price_text || 'R$ 0,00'}** • Total: **${formatBRL(lineTotal)}**`;
  }).join('\n\n');
}

function cartComponents(settings, items) {
  const rows = [];
  items.slice(0, 3).forEach((item) => {
    rows.push(row(
      btn(`az:cart_minus:${item.id}`, `- ${String(item.product_name).slice(0, 18)}`, ButtonStyle.Secondary),
      btn(`az:cart_plus:${item.id}`, `+ ${String(item.product_name).slice(0, 18)}`, ButtonStyle.Secondary)
    ));
  });
  rows.push(row(
    btn('az:cart_confirm', 'Confirmar compra', ButtonStyle.Success, '✅'),
    btn('az:cart_clear', 'Limpar carrinho', ButtonStyle.Secondary, settings.button_emoji),
    btn('az:notify_staff', 'Notificar staff', ButtonStyle.Primary, '🔔'),
    btn('az:cart_close', 'Fechar (staff)', ButtonStyle.Danger)
  ));
  return rows;
}

async function findOpenCart(instance, interaction) {
  return one(`
    select * from tickets
    where bot_instance_id=$1 and owner_id=$2 and status='cart'
    order by created_at desc
    limit 1
  `, [instance.id, interaction.user.id]);
}

async function renderCart(thread, instance, settings, ticket) {
  const items = await cartItems(thread.id);
  const total = cartTotal(items);
  const payload = {
    embeds: [embed(
      settings,
      '🛒 Carrinho de compras',
      `${cartLines(items)}\n\n**Total:** ${formatBRL(total)}\n\nUse os botões para aumentar/diminuir quantidades ou confirmar a compra.`,
      settings.sales_color
    )],
    components: cartComponents(settings, items)
  };
  let message = ticket?.cart_message_id ? await thread.messages.fetch(ticket.cart_message_id).catch(() => null) : null;
  if (message) await message.edit(payload).catch(() => null);
  else {
    message = await thread.send(payload);
    await query('update tickets set cart_message_id=$1, cart_total_text=$2 where thread_id=$3', [message.id, formatBRL(total), thread.id]);
  }
  return { items, total, message };
}

async function createCartThread(interaction, instance, settings) {
  const parent = await interaction.guild.channels.fetch(settings.ticket_channel_id || interaction.channelId).catch(() => null);
  if (!parent?.isTextBased?.()) throw new Error('Canal base de tickets/carrinhos nao configurado.');
  const thread = await parent.threads.create({
    name: `carrinho-${interaction.user.username}`.slice(0, 95),
    type: ChannelType.PrivateThread,
    invitable: false
  });
  await addTicketMembers(thread, interaction, instance, settings);
  await query(`
    insert into tickets (thread_id,bot_instance_id,guild_id,owner_id,status,purchase_status,closed_at)
    values ($1,$2,$3,$4,'cart','cart',null)
    on conflict (thread_id) do update set status='cart', purchase_status='cart', closed_at=null
  `, [thread.id, instance.id, interaction.guildId, interaction.user.id]);
  await thread.send(`${interaction.user} carrinho criado. Escolha mais produtos no painel ou ajuste a quantidade aqui.`).catch(() => null);
  return thread;
}

async function addProductToCart(interaction, instance, productId, variantIndex = null) {
  if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ ephemeral: true }).catch(() => null);
  const settings = await getSettings(instance.id);
  const item = await product(instance.id, productId);
  if (!item) return safeEphemeral(interaction, 'Produto nao encontrado.');
  const variant = item.product_type === 'variation' ? variationsOf(item)[Number(variantIndex)] : null;
  if (item.product_type === 'variation' && !variant) return chooseVariation(interaction, instance, productId);

  let ticket = await findOpenCart(instance, interaction);
  let thread = ticket ? await interaction.guild.channels.fetch(ticket.thread_id).catch(() => null) : null;
  if (!thread?.isThread?.()) {
    thread = await createCartThread(interaction, instance, settings);
    ticket = await one('select * from tickets where thread_id=$1', [thread.id]);
  }
  const variantJson = JSON.stringify(variant || null);
  const existing = await one(`
    select * from cart_items
    where thread_id=$1 and product_id=$2 and coalesce(variant::text,'null')=$3
    limit 1
  `, [thread.id, item.id, variantJson]);
  if (existing) {
    await query('update cart_items set quantity=quantity+1, updated_at=now() where id=$1', [existing.id]);
  } else {
    await query(`
      insert into cart_items (thread_id,product_id,product_name,variant,unit_price_text,quantity)
      values ($1,$2,$3,$4::jsonb,$5,1)
    `, [thread.id, item.id, item.name, variantJson, chosenPrice(item, variant)]);
  }
  await renderCart(thread, instance, settings, ticket);
  await logEvent(instance, settings, 'cart_item_added', `${interaction.user.tag} adicionou ${item.name}${variant?.name ? ` (${variant.name})` : ''} ao carrinho`, {
    actorId: interaction.user.id,
    targetId: String(item.id),
    channelId: thread.id,
    category: 'vendas'
  });
  const link = `https://discord.com/channels/${interaction.guildId}/${thread.id}`;
  return safeEphemeral(interaction, {
    content: `✅ Seu carrinho foi atualizado: ${thread}`,
    components: [row(new ButtonBuilder().setLabel('Ir para o carrinho').setStyle(ButtonStyle.Link).setURL(link))]
  });
}

async function ticketForThread(instance, threadId) {
  return one('select * from tickets where thread_id=$1 and bot_instance_id=$2', [threadId, instance.id]);
}

async function changeCartQuantity(interaction, instance, itemId, delta) {
  if (!interaction.channel?.isThread?.()) return safeEphemeral(interaction, 'Use dentro do carrinho.');
  const ticket = await ticketForThread(instance, interaction.channel.id);
  if (!ticket || ticket.owner_id !== interaction.user.id || ticket.status !== 'cart') return safeEphemeral(interaction, 'Esse carrinho nao pertence a voce.');
  const item = await one('select * from cart_items where id=$1 and thread_id=$2', [itemId, interaction.channel.id]);
  if (!item) return safeEphemeral(interaction, 'Item nao encontrado no carrinho.');
  if (delta < 0 && Number(item.quantity) <= 1) await query('delete from cart_items where id=$1', [item.id]);
  else await query('update cart_items set quantity=greatest(quantity+$1,1), updated_at=now() where id=$2', [delta, item.id]);
  const settings = await getSettings(instance.id);
  await renderCart(interaction.channel, instance, settings, ticket);
  return safeEphemeral(interaction, 'Carrinho atualizado.');
}

async function clearCart(interaction, instance) {
  if (!interaction.channel?.isThread?.()) return safeEphemeral(interaction, 'Use dentro do carrinho.');
  const ticket = await ticketForThread(instance, interaction.channel.id);
  if (!ticket || ticket.owner_id !== interaction.user.id || ticket.status !== 'cart') return safeEphemeral(interaction, 'Esse carrinho nao pertence a voce.');
  await query('delete from cart_items where thread_id=$1', [interaction.channel.id]);
  const settings = await getSettings(instance.id);
  await renderCart(interaction.channel, instance, settings, ticket);
  await logEvent(instance, settings, 'cart_cleared', `${interaction.user.tag} limpou o carrinho`, {
    actorId: interaction.user.id,
    channelId: interaction.channel.id,
    category: 'vendas'
  });
  return safeEphemeral(interaction, 'Carrinho limpo.');
}

async function confirmCart(interaction, instance) {
  if (!interaction.channel?.isThread?.()) return safeEphemeral(interaction, 'Use dentro do carrinho.');
  const ticket = await ticketForThread(instance, interaction.channel.id);
  if (!ticket || ticket.owner_id !== interaction.user.id || ticket.status !== 'cart') return safeEphemeral(interaction, 'Esse carrinho nao pertence a voce.');
  const settings = await getSettings(instance.id);
  const payment = await paymentSettings(instance.id);
  const items = await cartItems(interaction.channel.id);
  if (!items.length) return safeEphemeral(interaction, 'Adicione pelo menos um produto antes de confirmar.');
  const total = cartTotal(items);
  const terms = payment?.terms_text || 'Ao confirmar, voce declara que revisou os produtos, valores e entende que a entrega ocorre apos aprovacao do pagamento.';
  const payload = {
    embeds: [embed(settings, '📜 Termos da compra', `${terms}\n\n**Resumo:**\n${cartLines(items)}\n\n**Total:** ${formatBRL(total)}\n\nClique em **Aceitar termos e gerar Pix** para continuar.`, settings.sales_color)],
    components: [row(
      btn('az:terms_accept', 'Aceitar termos e gerar Pix', ButtonStyle.Success, '✅'),
      btn('az:cart_clear', 'Limpar carrinho', ButtonStyle.Secondary),
      btn('az:notify_staff', 'Notificar staff', ButtonStyle.Primary, '🔔'),
      btn('az:cart_close', 'Fechar (staff)', ButtonStyle.Danger)
    )]
  };
  let message = ticket.terms_message_id ? await interaction.channel.messages.fetch(ticket.terms_message_id).catch(() => null) : null;
  if (message) await message.edit(payload).catch(() => null);
  else {
    message = await interaction.channel.send(payload);
    await query("update tickets set terms_message_id=$1, purchase_status='terms' where thread_id=$2", [message.id, interaction.channel.id]);
  }
  await logEvent(instance, settings, 'cart_confirmed', `${interaction.user.tag} confirmou o carrinho e recebeu os termos`, {
    actorId: interaction.user.id,
    channelId: interaction.channel.id,
    total: formatBRL(total),
    category: 'vendas'
  });
  return safeEphemeral(interaction, 'Termos enviados no carrinho.');
}

async function generateCartPayment(interaction, instance) {
  if (!interaction.channel?.isThread?.()) return safeEphemeral(interaction, 'Use dentro do carrinho.');
  const ticket = await ticketForThread(instance, interaction.channel.id);
  if (!ticket || ticket.owner_id !== interaction.user.id) return safeEphemeral(interaction, 'Esse carrinho nao pertence a voce.');
  const settings = await getSettings(instance.id);
  const payment = await paymentSettings(instance.id);
  const items = await cartItems(interaction.channel.id);
  if (!items.length) return safeEphemeral(interaction, 'Carrinho vazio.');
  const total = cartTotal(items);
  let pixKey = '';
  if (payment?.private_details_encrypted) {
    try { pixKey = decrypt(payment.private_details_encrypted); } catch {}
  }
  if (!pixKey) return safeEphemeral(interaction, 'O dono ainda nao configurou a chave Pix no site.');
  const order = await one(`
    insert into payment_orders (
      bot_instance_id,ticket_thread_id,guild_id,buyer_id,product_name,product_variant,amount_text,provider,status
    ) values ($1,$2,$3,$4,'Carrinho',$5::jsonb,$6,$7,'pending')
    returning *
  `, [
    instance.id,
    interaction.channel.id,
    interaction.guildId,
    interaction.user.id,
    JSON.stringify(items.map((item) => ({
      product_id: item.product_id,
      product_name: item.product_name,
      variant: item.variant,
      unit_price_text: item.unit_price_text,
      quantity: item.quantity
    }))),
    formatBRL(total),
    payment?.provider || 'pix'
  ]);
  const txid = String(order.id).replace(/-/g, '').slice(0, 25);
  const payload = pixPayload({
    key: pixKey,
    amount: total,
    merchant: payment?.receiver_name || settings.brand_name || 'Aurora Store',
    city: payment?.pix_city || 'SAO PAULO',
    txid
  });
  if (!payload) return safeEphemeral(interaction, 'Chave Pix invalida ou ausente.');
  const file = await pixAttachment(payload);
  const paymentMessage = await interaction.channel.send({
    embeds: [embed(
      settings,
      '💠 Pix gerado automaticamente',
      `**Pedido:** ${order.id}\n**Total:** ${formatBRL(total)}\n\n${payment?.public_instructions ? `${payment.public_instructions}\n\n` : ''}Escaneie o QR Code ou copie o Pix abaixo:\n\n\`\`\`${payload}\`\`\`\n\nDepois de pagar, envie o comprovante aqui. O suporte pode clicar em **Aprovar compra**.`,
      settings.sales_color
    ).setImage('attachment://pix-aurora.png')],
    files: [file],
    components: [row(
      btn('az:approve', 'Aprovar compra', ButtonStyle.Success, '✅'),
      btn('az:notify_staff', 'Notificar staff', ButtonStyle.Primary, '🔔'),
      btn('az:close', 'Fechar (staff)', ButtonStyle.Danger)
    )]
  });
  await query(`
    update tickets
    set payment_order_id=$1, payment_message_id=$2, purchase_status='payment_pending', status='payment_pending', cart_total_text=$3
    where thread_id=$4
  `, [order.id, paymentMessage.id, formatBRL(total), interaction.channel.id]);
  await logEvent(instance, settings, 'payment_pix_generated', `Pix gerado para ${interaction.user.tag}: ${formatBRL(total)}`, {
    actorId: interaction.user.id,
    channelId: interaction.channel.id,
    targetId: order.id,
    total: formatBRL(total),
    category: 'vendas'
  });
  return safeEphemeral(interaction, 'Pix gerado no carrinho.');
}

function paymentText(payment) {
  if (!payment) return 'Pagamento: combine os detalhes com o suporte neste ticket.';
  const lines = [];
  const providerNames = {
    aurora: 'Aurora Pay interno',
    pix: 'Pix/manual',
    external: 'Link externo',
    manual: 'Manual / combinado no ticket',
    mercadopago: 'Mercado Pago',
    stripe: 'Stripe',
    pagseguro: 'PagSeguro',
    asaas: 'Asaas',
    other: 'Gateway externo'
  };
  lines.push(`Pagamento: **${providerNames[payment.provider] || payment.provider || 'Manual'}**`);
  if (payment.receiver_name) lines.push(`Recebedor: **${payment.receiver_name}**`);
  if (payment.checkout_mode === 'external') lines.push('Modo: gateway intermediario/checkout externo.');
  if (payment.public_instructions) lines.push(payment.public_instructions);
  if ((payment.provider === 'manual' || payment.provider === 'aurora') && payment.private_details_encrypted) {
    try {
      lines.push(`Dados privados configurados: **${decrypt(payment.private_details_encrypted)}**`);
    } catch {
      lines.push('Dados privados configurados, mas nao foi possivel descriptografar.');
    }
  }
  return lines.join('\n');
}

async function sync(instance, client, withMembersIntent = true, registerCommands = true) {
  const guild = client.guilds.cache.get(instance.guild_id);
  if (!guild) {
    await setError(instance.id, 'Esse bot ainda nao esta no servidor selecionado.');
    return;
  }
  await guild.channels.fetch().catch(() => null);
  await guild.roles.fetch().catch(() => null);
  const channels = [...guild.channels.cache.values()]
    .filter((channel) => channel?.type === ChannelType.GuildText || channel?.type === ChannelType.GuildAnnouncement)
    .map((channel) => ({ id: channel.id, name: channel.name, type: channel.type }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const roles = [...guild.roles.cache.values()]
    .filter((role) => !role.managed && role.name !== '@everyone')
    .map((role) => ({ id: role.id, name: role.name, color: role.hexColor }))
    .sort((a, b) => a.name.localeCompare(b.name));

  await query(`
    insert into guild_resources (bot_instance_id,channels,roles,updated_at)
    values ($1,$2::jsonb,$3::jsonb,now())
    on conflict (bot_instance_id) do update set channels=excluded.channels, roles=excluded.roles, updated_at=now()
  `, [instance.id, JSON.stringify(channels), JSON.stringify(roles)]);
  await query(`
    update bot_instances
    set guild_name=$1,
        bot_name=$2,
        bot_client_id=$3,
        last_seen_at=now(),
        last_error=null,
        updated_at=now()
    where id=$4
  `, [guild.name, client.user?.username || instance.bot_name || 'Bot', client.user?.id || null, instance.id]);
  if (withMembersIntent) await clearWarning(instance.id);
  if (registerCommands) await guild.commands.set(commands);
}

async function panel(instanceId, type, context = {}) {
  const settings = await getSettings(instanceId);
  context.settings = settings;
  if (type === 'auth') {
    return messagePayload(settings, {
      mode: settings.auth_mode,
      color: settings.auth_color,
      title: settings.auth_title,
      description: settings.auth_message,
      context,
      components: [row(btn('az:auth', renderTemplate(settings.auth_button_label, context), ButtonStyle.Success, settings.button_emoji))]
    });
  }
  if (type === 'ticket') {
    return messagePayload(settings, {
      mode: settings.ticket_mode,
      color: settings.ticket_color,
      title: settings.ticket_title,
      description: settings.ticket_message,
      context,
      components: [row(btn('az:ticket', renderTemplate(settings.ticket_button_label, context), ButtonStyle.Primary, settings.button_emoji))]
    });
  }
  const items = await products(instanceId);
  const rows = [];
  items.slice(0, 25).forEach((item, index) => {
    const n = Math.floor(index / 5);
    rows[n] ||= new ActionRowBuilder();
    const label = item.product_type === 'variation'
      ? `${renderTemplate(item.name, { ...context, product: item })} - opcoes`
      : renderTemplate(item.name, { ...context, product: item });
    rows[n].addComponents(btn(`az:buy:${item.id}`, label, ButtonStyle.Success, settings.button_emoji));
  });
  return messagePayload(settings, {
    mode: settings.sales_mode,
    color: settings.sales_color,
    title: settings.sales_title,
    description: items.length
      ? settings.sales_message
      : `${settings.sales_message || 'Escolha um produto para iniciar sua compra.'}\n\nNenhum produto ativo cadastrado ainda. Cadastre produtos no site e publique novamente.`,
    context,
    components: rows
  });
}

function productCard(settings, item, context = {}) {
  const variations = variationsOf(item);
  const price = item.product_type === 'variation'
    ? (variations[0]?.price || item.price || 'R$ 0,00')
    : (item.price || 'R$ 0,00');
  const stockText = item.stock === null || item.stock === undefined ? 'Ilimitado' : String(item.stock);
  const description = [
    item.delivery_content ? '⚡ **Entrega Automática!**' : '',
    item.description || 'Produto disponivel para compra.',
    '',
    `**Valor à vista**\n\`${price}\``,
    `**Restam**\n\`${stockText}\``
  ].filter(Boolean).join('\n');
  const card = embed(settings, renderTemplate(item.name, { ...context, product: item }), renderTemplate(description, { ...context, product: item }), settings.sales_color);
  if (/^https?:\/\//i.test(String(item.image_url || ''))) card.setImage(item.image_url);
  return {
    embeds: [card],
    components: [row(btn(`az:buy:${item.id}`, '🛒 Comprar', ButtonStyle.Success, settings.button_emoji))]
  };
}

async function publishSalesPanel(instance, channel, context = {}) {
  const settings = await getSettings(instance.id);
  const items = await products(instance.id);
  await channel.send(messagePayload(settings, {
    mode: settings.sales_mode,
    color: settings.sales_color,
    title: settings.sales_title || 'Minha loja',
    description: items.length
      ? settings.sales_message || 'Escolha um produto abaixo para abrir seu carrinho.'
      : `${settings.sales_message || 'Escolha um produto abaixo para abrir seu carrinho.'}\n\nNenhum produto ativo cadastrado ainda.`,
    context: { ...context, settings, channel },
    components: []
  }));
  for (const item of items.slice(0, 20)) {
    await channel.send(productCard(settings, item, { ...context, settings, channel }));
  }
}

async function supportMembersForGuild(guild, supportRoleIds, instance, settings) {
  if (!supportRoleIds.length) return [];
  let members = guild.members.cache;
  if (members.size < Number(guild.memberCount || 0)) {
    members = await guild.members.fetch().catch(async (error) => {
      await logEvent(instance, settings, 'ticket_support_sync_failed', `Nao consegui localizar membros dos cargos de suporte: ${error.message}`, {
        category: 'tickets',
        supportRoleIds
      }).catch(console.error);
      return null;
    });
  }
  if (!members) return null;
  return [...members.values()].filter((member) => !member.user?.bot && supportRoleIds.some((roleId) => member.roles.cache.has(roleId)));
}

async function addTicketMembers(thread, interaction, instance, settings) {
  await thread.members.add(interaction.user.id).catch(() => null);
  if (interaction.guild.ownerId) await thread.members.add(interaction.guild.ownerId).catch(() => null);
  const support = Array.isArray(settings.support_role_ids) ? settings.support_role_ids : [];
  if (!support.length) return;
  const members = await supportMembersForGuild(interaction.guild, support, instance, settings);
  if (!members) return;
  await Promise.all(members.map((member) => thread.members.add(member.id).catch(() => null)));
}

async function chooseVariation(interaction, instance, productId) {
  const settings = await getSettings(instance.id);
  const item = await product(instance.id, productId);
  if (!item) return safeEphemeral(interaction, 'Produto nao encontrado.');
  const variations = variationsOf(item);
  if (!variations.length) return addProductToCart(interaction, instance, productId);
  const rows = [];
  variations.slice(0, 25).forEach((variant, index) => {
    const n = Math.floor(index / 5);
    rows[n] ||= new ActionRowBuilder();
    rows[n].addComponents(btn(`az:variant:${item.id}:${index}`, `${variant.name} - ${variant.price}`, ButtonStyle.Primary, settings.button_emoji));
  });
  return safeEphemeral(interaction, {
    content: `Escolha uma variacao de **${item.name}** para continuar a compra:`,
    components: rows
  });
}

async function openTicket(interaction, instance, productId = null, variantIndex = null) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ ephemeral: true }).catch(() => null);
  }
  const settings = await getSettings(instance.id);
  const parent = await interaction.guild.channels.fetch(settings.ticket_channel_id || interaction.channelId).catch(() => null);
  if (!parent?.isTextBased?.()) return safeEphemeral(interaction, 'Canal base de tickets nao configurado.');
  const item = productId ? await product(instance.id, productId) : null;
  const variant = item && variantIndex !== null ? variationsOf(item)[Number(variantIndex)] || null : null;
  if (item?.product_type === 'variation' && !variant) return chooseVariation(interaction, instance, productId);
  const payment = item ? await paymentSettings(instance.id) : null;
  const thread = await parent.threads.create({
    name: `${item ? 'compra' : 'ticket'}-${interaction.user.username}`.slice(0, 95),
    type: ChannelType.PrivateThread,
    invitable: false
  });
  await addTicketMembers(thread, interaction, instance, settings);
  let order = null;
  if (item) {
    order = await one(`
      insert into payment_orders (
        bot_instance_id,ticket_thread_id,guild_id,buyer_id,product_id,product_name,product_variant,amount_text,provider,status
      ) values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,'pending')
      returning *
    `, [
      instance.id,
      thread.id,
      interaction.guildId,
      interaction.user.id,
      item.id,
      item.name,
      JSON.stringify(variant || null),
      chosenPrice(item, variant),
      payment?.provider || 'aurora'
    ]);
  }
  await query(`
    insert into tickets (thread_id,bot_instance_id,guild_id,owner_id,product_id,product_variant,status,closed_at)
    values ($1,$2,$3,$4,$5,$6::jsonb,'open',null)
    on conflict (thread_id) do update set status='open', closed_at=null
  `, [thread.id, instance.id, interaction.guildId, interaction.user.id, item?.id || null, JSON.stringify(variant || null)]);
  if (order) await query('update tickets set payment_order_id=$1 where thread_id=$2', [order.id, thread.id]);
  const mentions = (settings.support_role_ids || []).map((id) => `<@&${id}>`).join(' ');
  const ticketContext = { interaction, settings, product: item, variant, thread };
  const openTitle = item
    ? (settings.ticket_open_purchase_title || 'Novo pedido de {user}')
    : (settings.ticket_open_title || 'Novo atendimento de {user}');
  const openMessage = item
    ? (settings.ticket_open_purchase_message || `ID do pedido: **${order?.id || 'gerando'}**\nProduto: **{product}**\n${variant ? 'Variacao: **{variation}**\n' : ''}Preco: **${chosenPrice(item, variant)}**\n{productDescription}${variant?.description ? '\n{variationDescription}' : ''}\n\n${paymentText(payment)}\n\nAguarde o suporte aprovar sua compra.`)
    : (settings.ticket_open_message || 'Ola {user}, obrigado por abrir um ticket.\n\nExplique aqui o que voce precisa e aguarde o suporte. {supportRoleMentions}');
  const openingMessage = await thread.send({
    content: `${interaction.user} ${mentions}`.trim(),
    embeds: [embed(
      settings,
      renderTemplate(openTitle, ticketContext),
      renderTemplate(openMessage, ticketContext),
      settings.ticket_open_color || settings.ticket_color
    )],
    components: item
      ? [row(
        btn('az:approve', 'Aprovar compra', ButtonStyle.Success, '✅'),
        btn('az:notify_staff', 'Notificar staff', ButtonStyle.Primary, '🔔'),
        btn('az:close', 'Fechar (staff)', ButtonStyle.Danger, settings.button_emoji)
      )]
      : [row(
        btn('az:notify_staff', 'Notificar staff', ButtonStyle.Primary, '🔔'),
        btn('az:close', 'Fechar (staff)', ButtonStyle.Danger, settings.button_emoji)
      )]
  });
  await query('update tickets set controls_message_id=$1 where thread_id=$2 and bot_instance_id=$3', [openingMessage.id, thread.id, instance.id]);
  await logEvent(instance, settings, item ? 'cart_created' : 'ticket_opened', item ? `Carrinho criado: ${item.name} por ${interaction.user.tag}` : `Ticket aberto por ${interaction.user.tag}`, {
    actorId: interaction.user.id,
    targetId: item?.id ? String(item.id) : null,
    channelId: thread.id,
    product: item?.name,
    variant
  });
  return safeEphemeral(interaction, `Ticket criado: ${thread}`);
}

async function refreshOpenTicketControls(instance, client) {
  const settings = await getSettings(instance.id);
  const openTickets = await query(`
    select * from tickets
    where bot_instance_id=$1 and status='open'
    order by created_at desc
    limit 100
  `, [instance.id]);
  for (const ticket of openTickets) {
    const thread = await client.channels.fetch(ticket.thread_id).catch(() => null);
    if (!thread?.isThread?.() || thread.archived) continue;
    const components = ticket.product_id
      ? [row(
        btn('az:approve', 'Aprovar compra', ButtonStyle.Success, '✅'),
        btn('az:notify_staff', 'Notificar staff', ButtonStyle.Primary, '🔔'),
        btn('az:close', 'Fechar (staff)', ButtonStyle.Danger, settings.button_emoji)
      )]
      : [row(
        btn('az:notify_staff', 'Notificar staff', ButtonStyle.Primary, '🔔'),
        btn('az:close', 'Fechar (staff)', ButtonStyle.Danger, settings.button_emoji)
      )];
    const existing = ticket.controls_message_id
      ? await thread.messages.fetch(ticket.controls_message_id).catch(() => null)
      : null;
    if (existing) await existing.edit({ components }).catch(() => null);
    else {
      const message = await thread.send({ content: 'Controles do atendimento', components }).catch(() => null);
      if (message) await query('update tickets set controls_message_id=$1 where thread_id=$2 and bot_instance_id=$3', [message.id, thread.id, instance.id]);
    }
  }
}

async function syncOpenTicketSupportMembers(instance, client) {
  const settings = await getSettings(instance.id);
  const guild = client.guilds.cache.get(instance.guild_id);
  if (!guild) return;
  const supportRoleIds = Array.isArray(settings.support_role_ids) ? settings.support_role_ids.filter(Boolean) : [];
  const staffMembers = await supportMembersForGuild(guild, supportRoleIds, instance, settings);
  if (staffMembers === null) return;
  const tickets = await query(`
    select thread_id,owner_id from tickets
    where bot_instance_id=$1 and status<>'closed'
    order by created_at desc
    limit 100
  `, [instance.id]);
  let updated = 0;
  for (const ticket of tickets) {
    const thread = await client.channels.fetch(ticket.thread_id).catch(() => null);
    if (!thread?.isThread?.() || thread.archived) continue;
    const desired = new Set([
      client.user.id,
      ticket.owner_id,
      guild.ownerId,
      ...staffMembers.map((member) => member.id)
    ].filter(Boolean));
    const current = await thread.members.fetch().catch(() => null);
    if (!current) continue;
    await Promise.all([...desired].map((memberId) => thread.members.add(memberId).catch(() => null)));
    await Promise.all([...current.values()]
      .filter((member) => !desired.has(member.id))
      .map((member) => thread.members.remove(member.id).catch(() => null)));
    updated += 1;
  }
  if (updated) {
    await logEvent(instance, settings, 'ticket_support_synced', `Cargos de suporte sincronizados em ${updated} ticket(s) aberto(s).`, {
      supportRoleIds,
      staffCount: staffMembers.length,
      ticketCount: updated,
      category: 'tickets'
    });
  }
}

function isSupportStaff(interaction, settings) {
  const support = Array.isArray(settings.support_role_ids) ? settings.support_role_ids : [];
  return interaction.guild?.ownerId === interaction.user.id
    || support.some((roleId) => interaction.member?.roles?.cache?.has(roleId));
}

async function approvePurchase(interaction, instance) {
  if (!interaction.channel?.isThread?.()) return safeEphemeral(interaction, 'Use dentro de um ticket/carrinho de compra.');
  const settings = await getSettings(instance.id);
  const ticket = await one('select * from tickets where thread_id=$1 and bot_instance_id=$2', [interaction.channel.id, instance.id]);
  if (!ticket) return safeEphemeral(interaction, 'Compra nao encontrada.');
  if (!isSupportStaff(interaction, settings)) return safeEphemeral(interaction, 'Apenas o dono do servidor ou cargos de suporte configurados podem aprovar.');
  if (ticket.purchase_status === 'approved') return safeEphemeral(interaction, 'Essa compra ja foi aprovada.');

  const items = await cartItems(ticket.thread_id);
  if (!items.length && !ticket.product_id) return safeEphemeral(interaction, 'Esse carrinho nao possui produtos.');
  const legacyItem = ticket.product_id ? await product(instance.id, ticket.product_id) : null;
  const approvalItems = items.length ? items : [{
    product_id: legacyItem?.id,
    product_name: legacyItem?.name || 'Produto',
    variant: ticket.product_variant,
    unit_price_text: chosenPrice(legacyItem, ticket.product_variant),
    quantity: 1
  }];

  const deliveryParts = [];
  for (const cartItem of approvalItems) {
    const item = await product(instance.id, cartItem.product_id);
    if (item?.stock !== null && item?.stock !== undefined) {
      if (Number(item.stock) < Number(cartItem.quantity || 1)) return safeEphemeral(interaction, `Estoque insuficiente para ${item.name}.`);
      const updatedProduct = await one('update products set stock = greatest(stock - $1, 0) where id=$2 and bot_instance_id=$3 returning *', [Number(cartItem.quantity || 1), item.id, instance.id]) || item;
      const threshold = Number(settings.stock_warn_threshold ?? 3);
      if (updatedProduct.stock !== null && updatedProduct.stock !== undefined && Number(updatedProduct.stock) <= threshold) {
        await logEvent(instance, settings, Number(updatedProduct.stock) <= 0 ? 'stock_empty' : 'stock_low', `Estoque de ${item.name}: ${updatedProduct.stock}`, {
          targetId: String(item.id),
          product: item.name,
          stock: updatedProduct.stock,
          category: 'vendas'
        });
      }
    }
    if (settings.delivery_mode === 'auto') {
      deliveryParts.push(`**${cartItem.product_name}${cartItem.variant?.name ? ` — ${cartItem.variant.name}` : ''} x${cartItem.quantity || 1}**\n${item?.delivery_content || 'Sem conteudo de entrega automatica cadastrado.'}`);
    }
  }

  await query("update tickets set purchase_status='approved', status='approved', approved_at=now() where thread_id=$1", [ticket.thread_id]);
  if (ticket.payment_order_id) {
    await query("update payment_orders set status='approved', approved_at=now() where id=$1 and bot_instance_id=$2", [ticket.payment_order_id, instance.id]);
  }
  const buyer = await interaction.client.users.fetch(ticket.owner_id).catch(() => null);
  const deliveryContent = deliveryParts.join('\n\n');
  const firstProduct = { name: approvalItems[0]?.product_name || 'Carrinho', price: ticket.cart_total_text || '' };
  const context = { interaction, settings, product: firstProduct, variant: approvalItems[0]?.variant, deliveryContent };
  const deliveryBody = settings.delivery_mode === 'auto'
    ? `${settings.delivery_message || ''}\n\n${deliveryContent ? `**Seus produtos:**\n${deliveryContent}` : ''}`
    : settings.delivery_message || 'Sua compra foi aprovada. O suporte enviara sua entrega em breve.';

  if (buyer) {
    await buyer.send({
      embeds: [embed(settings, renderTemplate(settings.delivery_title, context), renderTemplate(deliveryBody, context), settings.delivery_color)],
      components: [row(
        btn(`az:review:${ticket.thread_id}:1`, '⭐ 1', ButtonStyle.Secondary),
        btn(`az:review:${ticket.thread_id}:2`, '⭐ 2', ButtonStyle.Secondary),
        btn(`az:review:${ticket.thread_id}:3`, '⭐ 3', ButtonStyle.Secondary),
        btn(`az:review:${ticket.thread_id}:4`, '⭐ 4', ButtonStyle.Secondary),
        btn(`az:review:${ticket.thread_id}:5`, '⭐ 5', ButtonStyle.Success)
      )]
    }).catch(() => null);
  }

  await logEvent(instance, settings, 'purchase_approved', `Compra aprovada para <@${ticket.owner_id}>: ${approvalItems.map((item) => `${item.product_name} x${item.quantity || 1}`).join(', ')}`, {
    actorId: interaction.user.id,
    targetId: ticket.owner_id,
    channelId: interaction.channel.id,
    items: approvalItems,
    category: 'vendas'
  });

  await safeEphemeral(interaction, 'Compra aprovada. Entrega enviada no privado e avaliacao liberada.');
  await interaction.channel.send(`✅ Compra aprovada por ${interaction.user}. Entrega enviada para <@${ticket.owner_id}>. Este carrinho sera fechado em 5 segundos.`).catch(() => null);
  setTimeout(() => interaction.channel.setArchived(true, 'Compra aprovada no Aurora').catch(() => null), 5000);
}

async function submitReview(interaction, instance, threadId, rating) {
  const stars = Math.max(1, Math.min(5, Number(rating) || 5));
  const settings = await getSettings(instance.id);
  const ticket = await one('select * from tickets where thread_id=$1 and bot_instance_id=$2', [threadId, instance.id]);
  if (!ticket || ticket.owner_id !== interaction.user.id) return interaction.reply({ content: 'Avaliacao nao encontrada para voce.', ephemeral: true });
  if (ticket.reviewed_at) return interaction.reply({ content: 'Voce ja avaliou essa compra. Obrigado!', ephemeral: true });
  const item = ticket.product_id ? await product(instance.id, ticket.product_id) : null;
  await query('update tickets set rating=$1, reviewed_at=now() where thread_id=$2', [stars, threadId]);

  const channel = settings.review_channel_id ? await interaction.client.channels.fetch(settings.review_channel_id).catch(() => null) : null;
  const context = { interaction, settings, product: item, variant: ticket.product_variant, stars: String(stars) };
  if (channel?.isTextBased?.()) {
    const reviewEmbed = embed(settings, renderTemplate(settings.review_title, context), renderTemplate(settings.review_message, context), settings.review_color)
      .addFields(
        { name: 'Produto comprado', value: item?.name || 'Produto', inline: true },
        { name: 'Avaliacao', value: '⭐'.repeat(stars), inline: true },
        { name: 'Comprador', value: `${interaction.user}`, inline: true }
      );
    if (settings.review_gif_url) reviewEmbed.setImage(settings.review_gif_url);
    await channel.send({ embeds: [reviewEmbed] }).catch(() => null);
  }
  await logEvent(instance, settings, 'review_created', `${interaction.user.tag} avaliou ${item?.name || 'produto'} com ${stars} estrelas`, {
    actorId: interaction.user.id,
    targetId: item?.id ? String(item.id) : null,
    rating: stars,
    product: item?.name
  });
  return interaction.reply({ content: `Obrigado pela avaliacao de ${stars} estrela(s)!`, ephemeral: true });
}

async function notifyStaff(interaction, instance) {
  if (!interaction.channel?.isThread?.()) return safeEphemeral(interaction, 'Use dentro do seu ticket ou carrinho.');
  const settings = await getSettings(instance.id);
  const ticket = await ticketForThread(instance, interaction.channel.id);
  if (!ticket) return safeEphemeral(interaction, 'Ticket nao encontrado.');
  if (ticket.owner_id !== interaction.user.id) return safeEphemeral(interaction, 'Somente a pessoa que abriu este ticket pode notificar a staff.');
  if (ticket.status === 'closed') return safeEphemeral(interaction, 'Este ticket ja esta fechado.');
  const support = Array.isArray(settings.support_role_ids) ? settings.support_role_ids.filter(Boolean) : [];
  if (!support.length) return safeEphemeral(interaction, 'O dono do bot ainda nao configurou cargos de suporte no painel.');

  const cooldownMs = 5 * 60 * 1000;
  const lastNotification = ticket.last_staff_notification_at ? new Date(ticket.last_staff_notification_at).getTime() : 0;
  const remaining = cooldownMs - (Date.now() - lastNotification);
  if (remaining > 0) {
    const minutes = Math.max(1, Math.ceil(remaining / 60000));
    return safeEphemeral(interaction, `A staff ja foi notificada. Aguarde ${minutes} minuto(s) para notificar novamente.`);
  }

  const mentions = support.map((roleId) => `<@&${roleId}>`).join(' ');
  await interaction.channel.send({
    content: `${mentions}\n🔔 **Staff solicitada por ${interaction.user}.** Quando puder, responda neste ticket.`,
    allowedMentions: { roles: support, users: [interaction.user.id] }
  });
  await query('update tickets set last_staff_notification_at=now() where thread_id=$1 and bot_instance_id=$2', [ticket.thread_id, instance.id]);
  await logEvent(instance, settings, 'ticket_staff_notified', `${interaction.user.tag} notificou a staff`, {
    actorId: interaction.user.id,
    channelId: interaction.channel.id,
    supportRoleIds: support,
    category: ticket.status === 'cart' || ticket.status === 'payment_pending' ? 'vendas' : 'tickets'
  });
  return safeEphemeral(interaction, 'Staff notificada. Aguarde uma resposta neste ticket.');
}

async function closeTicket(interaction, instance) {
  if (!interaction.channel?.isThread?.()) return interaction.reply({ content: 'Use dentro de um ticket.', ephemeral: true });
  const settings = await getSettings(instance.id);
  const ticket = await ticketForThread(instance, interaction.channel.id);
  if (!ticket) return safeEphemeral(interaction, 'Ticket nao encontrado.');
  if (!isSupportStaff(interaction, settings)) {
    return safeEphemeral(interaction, 'Somente o dono do servidor ou cargos de suporte configurados podem fechar este ticket. Use Notificar staff se precisar de atendimento.');
  }
  await query("update tickets set status='closed', closed_at=now() where thread_id=$1", [interaction.channel.id]);
  await logEvent(instance, settings, 'ticket_closed', `Ticket fechado por ${interaction.user.tag}`, {
    actorId: interaction.user.id,
    channelId: interaction.channel.id
  });
  await interaction.reply('Fechado. Este tópico será arquivado em 5 segundos.');
  setTimeout(() => interaction.channel.setArchived(true).catch(() => null), 5000);
}

async function handle(interaction, instance) {
  if (interaction.isButton() && interaction.customId.startsWith('az:review:')) {
    const [, action, threadId, rating] = interaction.customId.split(':');
    if (action === 'review') return submitReview(interaction, instance, threadId, Number(rating));
  }
  if (instance.guild_id !== interaction.guildId) return;
  if (interaction.isChatInputCommand() && interaction.commandName === 'painel') {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return interaction.reply({ content: 'Voce precisa de Gerenciar Servidor.', ephemeral: true });
    const type = interaction.options.getString('tipo', true);
    const channel = interaction.options.getChannel('canal', true);
    if (type === 'sales') {
      await publishSalesPanel(instance, channel, { interaction, channel });
      return interaction.reply({ content: `Vitrine e produtos publicados em ${channel}.`, ephemeral: true });
    }
    const payload = await panel(instance.id, type, { interaction, channel });
    await channel.send(payload);
    return interaction.reply({ content: `Painel publicado em ${channel}.`, ephemeral: true });
  }
  if (!interaction.isButton() || !interaction.customId.startsWith('az:')) return;
  const [, action, value, extra] = interaction.customId.split(':');
  if (action === 'auth') {
    const settings = await getSettings(instance.id);
    if (!settings.verified_role_id) return interaction.reply({ content: 'Cargo verificado nao configurado.', ephemeral: true });
    await interaction.member.roles.add(settings.verified_role_id).catch((error) => {
      const message = `Falha ao aplicar cargo verificado: ${error.message}. Verifique permissao Gerenciar Cargos e hierarquia.`;
      setWarning(instance.id, message).catch(console.error);
    });
    if (settings.remove_auto_role_after_verify && settings.auto_role_id) {
      await interaction.member.roles.remove(settings.auto_role_id).catch((error) => {
        const message = `Falha ao remover cargo automatico apos verificar: ${error.message}.`;
        setWarning(instance.id, message).catch(console.error);
      });
    }
    await logEvent(instance, settings, 'auth_verified', `${interaction.user.tag} verificou acesso`, {
      actorId: interaction.user.id,
      channelId: interaction.channelId
    });
    return interaction.reply({ content: 'Acesso liberado.', ephemeral: true });
  }
  if (action === 'ticket') return openTicket(interaction, instance);
  if (action === 'buy') return chooseVariation(interaction, instance, Number(value));
  if (action === 'variant') return addProductToCart(interaction, instance, Number(value), Number(extra));
  if (action === 'cart_plus') return changeCartQuantity(interaction, instance, Number(value), 1);
  if (action === 'cart_minus') return changeCartQuantity(interaction, instance, Number(value), -1);
  if (action === 'cart_clear') return clearCart(interaction, instance);
  if (action === 'cart_close') return closeTicket(interaction, instance);
  if (action === 'cart_confirm') return confirmCart(interaction, instance);
  if (action === 'terms_accept') return generateCartPayment(interaction, instance);
  if (action === 'approve') return approvePurchase(interaction, instance);
  if (action === 'notify_staff') return notifyStaff(interaction, instance);
  if (action === 'close') return closeTicket(interaction, instance);
}

async function start(instance) {
  if (running.has(instance.id)) return;

  const buildClient = (withMembersIntent = true) => {
    const intents = withMembersIntent
      ? [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages]
      : [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages];
    const client = new Client({ intents });
    let pendingResourceSync = null;
    const scheduleResourceSync = () => {
      if (pendingResourceSync) clearTimeout(pendingResourceSync);
      pendingResourceSync = setTimeout(() => {
        pendingResourceSync = null;
        sync(instance, client, withMembersIntent, false).catch((error) => setError(instance.id, error.message));
      }, 1200);
    };

    client.once(Events.ClientReady, async () => {
      const mode = withMembersIntent ? 'com members intent' : 'modo basico sem members intent';
      console.log(`[${runnerName}] Online: ${client.user.tag} / ${instance.guild_name} (${mode})`);
      await sync(instance, client, withMembersIntent).catch((error) => setError(instance.id, error.message));
      await refreshOpenTicketControls(instance, client).catch(console.error);
      if (withMembersIntent) {
        await auditAutoRoles(instance, client, 'bot online / sincronizacao').catch(console.error);
        await auditRecentWelcomes(instance, client).catch(console.error);
        await syncOpenTicketSupportMembers(instance, client).catch(console.error);
      }
    });

    client.on(Events.Error, (error) => {
      console.error(`[${runnerName}] Discord client error (${instance.bot_name || instance.id}):`, error);
      setError(instance.id, error.message).catch(console.error);
    });
    client.on(Events.Warn, (warning) => console.warn(`[${runnerName}] Discord warning (${instance.bot_name || instance.id}):`, warning));
    client.on(Events.GuildCreate, () => sync(instance, client, withMembersIntent).catch((error) => setError(instance.id, error.message)));
    client.on(Events.ChannelCreate, scheduleResourceSync);
    client.on(Events.ChannelUpdate, scheduleResourceSync);
    client.on(Events.ChannelDelete, scheduleResourceSync);
    client.on(Events.GuildRoleCreate, scheduleResourceSync);
    client.on(Events.GuildRoleUpdate, scheduleResourceSync);
    client.on(Events.GuildRoleDelete, scheduleResourceSync);

    if (withMembersIntent) {
      client.on(Events.GuildMemberAdd, async (member) => {
        if (member.guild.id !== instance.guild_id) return;
        const settings = await getSettings(instance.id);
        const features = await getFeatures(instance.id);
        await logEvent(instance, settings, 'member_join', `${member.user.tag} entrou no servidor`, {
          actorId: member.user.id,
          category: features.automations.invite_tracker_enabled ? 'entrada' : undefined
        });
        await handleAntiFake(member, instance, settings, features);
        await handleAntiRaid(member, instance, client, settings, features);
        await applyAutoRole(member, instance, settings, 'entrada no servidor');
        await sendWelcome(member, instance, settings);
      });

      client.on(Events.GuildMemberRemove, async (member) => {
        if (member.guild.id !== instance.guild_id) return;
        const settings = await getSettings(instance.id);
        await query('delete from member_welcome_deliveries where bot_instance_id=$1 and user_id=$2', [instance.id, member.id]).catch(console.error);
        await logEvent(instance, settings, 'member_leave', `${member.user?.tag || member.id} saiu do servidor`, {
          actorId: member.id
        });
      });
    }

    client.on(Events.MessageDelete, async (message) => {
      if (message.guildId !== instance.guild_id) return;
      const settings = await getSettings(instance.id);
      const features = await getFeatures(instance.id);
      if (features.protect.moderation_enabled === false || features.protect.log_deleted_messages === false) return;
      await logEvent(instance, settings, 'message_deleted', `Mensagem apagada em <#${message.channelId}>${message.author ? ` por ${message.author.tag}` : ''}`, {
        actorId: message.author?.id,
        channelId: message.channelId,
        content: String(message.content || '').slice(0, 500)
      });
    });

    client.on(Events.MessageCreate, async (message) => {
      if (message.guildId !== instance.guild_id) return;
      const settings = await getSettings(instance.id);
      const features = await getFeatures(instance.id);
      await handleCleanupMessage(message, instance, settings, features);
    });

    client.on(Events.InteractionCreate, async (interaction) => {
      try {
        await handle(interaction, instance);
      } catch (error) {
        console.error(error);
        if (interaction.isRepliable()) {
          const body = { content: 'Erro ao executar acao. Confira permissoes do bot.', ephemeral: true };
          if (interaction.deferred || interaction.replied) await interaction.followUp(body).catch(() => null);
          else await interaction.reply(body).catch(() => null);
        }
      }
    });

    return client;
  };

  let client = buildClient(true);
  try {
    await client.login(decrypt(instance.token_encrypted));
    const auditTimer = setInterval(() => {
      auditAutoRoles(instance, client, 'auditoria periodica').catch(console.error);
    }, autoRoleAuditInterval);
    const welcomeTimer = setInterval(() => auditRecentWelcomes(instance, client).catch(console.error), 60000);
    const resourceTimer = setInterval(() => sync(instance, client, true, false).catch(console.error), 60000);
    const supportTimer = setInterval(() => syncOpenTicketSupportMembers(instance, client).catch(console.error), 60000);
    const featureTimer = setInterval(async () => {
      const features = await getFeatures(instance.id);
      const settings = await getSettings(instance.id);
      await applyChannelLocks(instance, client, settings, features, 'sincronizacao').catch(console.error);
    }, 30000);
    const autoMessageTimer = setInterval(() => runAutoMessage(instance, client).catch(console.error), 60000);
    const backupTimer = setInterval(() => runCloudBackup(instance).catch(console.error), 60 * 60 * 1000);
    running.set(instance.id, { client, withMembersIntent: true, nextFullRetryAt: null, auditTimer, welcomeTimer, resourceTimer, supportTimer, featureTimer, autoMessageTimer, backupTimer });
  } catch (error) {
    if (/disallowed intents/i.test(error.message || '')) {
      client.destroy();
      const warning = 'Auto role e boas-vindas nao podem funcionar neste bot enquanto o Server Members Intent estiver desativado no Discord Developer Portal. O Discord nao envia o evento de entrada neste modo. Ative o intent, salve, e aguarde o runner religar em modo completo.';
      console.warn(`[${runnerName}] ${instance.bot_name || instance.guild_name} sem Server Members Intent. Iniciando em modo basico.`);
      await setWarning(instance.id, warning).catch(console.error);
      client = buildClient(false);
      try {
        await client.login(decrypt(instance.token_encrypted));
        const featureTimer = setInterval(async () => {
          const features = await getFeatures(instance.id);
          const settings = await getSettings(instance.id);
          await applyChannelLocks(instance, client, settings, features, 'sincronizacao').catch(console.error);
        }, 30000);
        const autoMessageTimer = setInterval(() => runAutoMessage(instance, client).catch(console.error), 60000);
        const backupTimer = setInterval(() => runCloudBackup(instance).catch(console.error), 60 * 60 * 1000);
        const resourceTimer = setInterval(() => sync(instance, client, false, false).catch(console.error), 60000);
        running.set(instance.id, { client, withMembersIntent: false, nextFullRetryAt: Date.now() + fullIntentRetryInterval, resourceTimer, featureTimer, autoMessageTimer, backupTimer });
        return;
      } catch (fallbackError) {
        await setError(instance.id, fallbackError.message);
        return;
      }
    }
    await setError(instance.id, error.message);
  }
}
async function stop(id) {
  const entry = running.get(id);
  if (!entry) return;
  if (entry.auditTimer) clearInterval(entry.auditTimer);
  if (entry.welcomeTimer) clearInterval(entry.welcomeTimer);
  if (entry.resourceTimer) clearInterval(entry.resourceTimer);
  if (entry.supportTimer) clearInterval(entry.supportTimer);
  if (entry.featureTimer) clearInterval(entry.featureTimer);
  if (entry.autoMessageTimer) clearInterval(entry.autoMessageTimer);
  if (entry.backupTimer) clearInterval(entry.backupTimer);
  entry.client.destroy();
  running.delete(id);
}

async function reconcile() {
  const data = await query('select * from bot_instances where enabled=true');
  const ids = new Set((data || []).map((item) => item.id));
  for (const instance of data || []) {
    const entry = running.get(instance.id);
    if (entry && !entry.withMembersIntent && entry.nextFullRetryAt && Date.now() >= entry.nextFullRetryAt) {
      console.log(`[${runnerName}] Tentando religar ${instance.bot_name || instance.guild_name} em modo completo.`);
      await stop(instance.id);
    }
    await start(instance);
  }
  for (const id of running.keys()) if (!ids.has(id)) await stop(id);
}

async function shutdown(signal) {
  console.log(`[${runnerName}] Encerrando por ${signal}.`);
  for (const id of [...running.keys()]) await stop(id);
  await pool.end();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT').catch((error) => {
  console.error(error);
  process.exit(1);
}));
process.on('SIGTERM', () => shutdown('SIGTERM').catch((error) => {
  console.error(error);
  process.exit(1);
}));

console.log(`[${runnerName}] Aurora Zero runner iniciado. Poll: ${pollInterval}ms.`);
await ensureRuntimeSchema();
await reconcile();
setInterval(() => reconcile().catch((error) => console.error(error)), pollInterval);
