import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import passport from 'passport';
import { Strategy as DiscordStrategy } from 'passport-discord';
import pg from 'pg';

const { Pool } = pg;
const app = express();
const version = 'aurora-zero-1.1.0-pg';
const cookieName = 'aurora_zero_sid';
const week = 60 * 60 * 24 * 7;
const manageGuild = 0x20n;
const apiDir = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(apiDir, '..', 'public');
const env = (name) => String(process.env[name] || '').trim();
// Permissoes pedidas no botao "Adicionar bot ao servidor".
// Inclui: Ver Canais, Enviar Mensagens, Embeds, Anexos, Historico,
// Gerenciar Cargos, Gerenciar Canais, Gerenciar Expressoes/Emojis,
// Usar Comandos, Gerenciar Threads, Criar Threads Privadas,
// Enviar em Threads e Gerenciar Mensagens.
const botPermissions = 364267039760n;

const key = Buffer.from(env('BOT_ENCRYPTION_KEY'), 'base64');
const pool = env('DATABASE_URL')
  ? new Pool({
      connectionString: env('DATABASE_URL'),
      ssl: { rejectUnauthorized: false },
      max: 3
    })
  : null;

app.use(express.json({ limit: '1mb' }));
app.use(passport.initialize());

passport.use(new DiscordStrategy({
  clientID: env('CLIENT_ID') || 'missing',
  clientSecret: env('CLIENT_SECRET') || 'missing',
  callbackURL: env('REDIRECT_URI') || 'http://localhost/auth/discord/callback',
  scope: ['identify', 'guilds']
}, (accessToken, refreshToken, profile, done) => done(null, {
  id: profile.id,
  username: profile.username,
  avatar: profile.avatar,
  accessToken,
  refreshToken
})));

function missing(names) {
  return names.filter((name) => !env(name));
}

function authReady() {
  const absent = missing(['CLIENT_ID', 'CLIENT_SECRET', 'REDIRECT_URI', 'SESSION_SECRET', 'BOT_ENCRYPTION_KEY']);
  if (absent.length) throw Object.assign(new Error(`Env OAuth ausente: ${absent.join(', ')}`), { status: 500 });
  if (key.length !== 32) throw Object.assign(new Error('BOT_ENCRYPTION_KEY precisa ser Base64 de 32 bytes.'), { status: 500 });
}

function dbReady() {
  authReady();
  const absent = missing(['DATABASE_URL']);
  if (absent.length) throw Object.assign(new Error(`Env banco ausente: ${absent.join(', ')}`), { status: 500 });
  if (!pool) throw Object.assign(new Error('Pool Postgres nao inicializado.'), { status: 500 });
}

async function query(sql, params = []) {
  dbReady();
  const result = await pool.query(sql, params);
  return result.rows;
}

async function one(sql, params = []) {
  return (await query(sql, params))[0] || null;
}

function sign(value) {
  return crypto.createHmac('sha256', env('SESSION_SECRET') || 'missing').update(value).digest('base64url');
}

function readCookie(req) {
  const raw = (req.headers.cookie || '').split(';').map((x) => x.trim()).find((x) => x.startsWith(`${cookieName}=`));
  if (!raw) return null;
  const [value, mac] = raw.slice(cookieName.length + 1).split('.');
  if (!value || !mac) return null;
  const expected = sign(value);
  if (mac.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  return value;
}

function setCookie(res, value) {
  res.setHeader('Set-Cookie', `${cookieName}=${value}.${sign(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${week}`);
}

function clearCookie(res) {
  res.setHeader('Set-Cookie', `${cookieName}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
}

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(String(text || ''), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, data, tag].map((part) => part.toString('base64')).join('.');
}

function decrypt(value) {
  const [iv, data, tag] = String(value || '').split('.').map((part) => Buffer.from(part, 'base64'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

function encodeSession(data) {
  return Buffer.from(encrypt(JSON.stringify(data)), 'utf8').toString('base64url');
}

function decodeSession(value) {
  return JSON.parse(decrypt(Buffer.from(String(value || ''), 'base64url').toString('utf8')));
}

function text(value, max = 500) {
  return String(value || '').trim().slice(0, max);
}

function snowflake(value) {
  return String(value || '').replace(/\D/g, '');
}

function arrayOfSnowflakes(value) {
  return Array.isArray(value) ? value.map(snowflake).filter(Boolean) : [];
}

function json(value) {
  return JSON.stringify(value ?? []);
}

function emojiName(value) {
  return text(value || 'aurora', 32).toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^_+|_+$/g, '') || 'aurora';
}

function messageMode(value) {
  return value === 'simple' ? 'simple' : 'embed';
}

function hexColor(value, fallback = '#5865f2') {
  return /^#[0-9a-f]{6}$/i.test(String(value || '')) ? String(value) : fallback;
}

function productType(value) {
  return value === 'variation' ? 'variation' : 'single';
}

function productVariations(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => ({
      name: text(item?.name, 80),
      price: text(item?.price, 40),
      description: text(item?.description, 500)
    }))
    .filter((item) => item.name && item.price)
    .slice(0, 25);
}

function paymentProvider(value) {
  const allowed = new Set(['aurora', 'pix', 'external', 'manual', 'mercadopago', 'stripe', 'pagseguro', 'asaas', 'other']);
  return allowed.has(value) ? value : 'aurora';
}

function checkoutMode(value) {
  return value === 'external' ? 'external' : 'ticket';
}

function deliveryMode(value) {
  return value === 'auto' ? 'auto' : 'manual';
}

function integerOrNull(value, min = 0, max = 999999) {
  if (value === null || value === undefined || value === '') return null;
  const number = Math.trunc(Number(value));
  if (!Number.isFinite(number)) return null;
  return Math.min(Math.max(number, min), max);
}

function maskPrivateDetails(value) {
  const raw = text(value, 300);
  if (!raw) return '';
  if (raw.length <= 6) return '••••••';
  return `${raw.slice(0, 3)}••••••${raw.slice(-3)}`;
}

function publicPayment(row) {
  if (!row) {
    return {
      provider: 'aurora',
      checkout_mode: 'ticket',
      receiver_name: '',
      public_instructions: '',
      terms_text: 'Ao confirmar, voce declara que revisou os produtos, valores e entende que a entrega ocorre apos aprovacao do pagamento.',
      pix_city: 'SAO PAULO',
      has_private_details: false,
      private_details_preview: ''
    };
  }
  let preview = '';
  if (row.private_details_encrypted) {
    try {
      preview = maskPrivateDetails(decrypt(row.private_details_encrypted));
    } catch {
      preview = '••••••';
    }
  }
  return {
    provider: row.provider || 'aurora',
    checkout_mode: row.checkout_mode || 'ticket',
    receiver_name: row.receiver_name || '',
    public_instructions: row.public_instructions || '',
    terms_text: row.terms_text || 'Ao confirmar, voce declara que revisou os produtos, valores e entende que a entrega ocorre apos aprovacao do pagamento.',
    pix_city: row.pix_city || 'SAO PAULO',
    has_private_details: Boolean(row.private_details_encrypted),
    private_details_preview: preview
  };
}

function hasManageGuild(guild) {
  if (guild.owner) return true;
  try {
    return (BigInt(guild.permissions || 0) & manageGuild) === manageGuild;
  } catch {
    return false;
  }
}

function botInviteUrl(clientId, guildId = null) {
  if (!clientId) return null;
  const params = new URLSearchParams({
    client_id: clientId,
    permissions: botPermissions.toString(),
    scope: 'bot applications.commands'
  });
  if (guildId) {
    params.set('guild_id', guildId);
    params.set('disable_guild_select', 'true');
  }
  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

function publicInstance(instance) {
  if (!instance) return null;
  return {
    id: instance.id,
    guild_id: instance.guild_id,
    guild_name: instance.guild_name,
    bot_name: instance.bot_name,
    bot_client_id: instance.bot_client_id,
    enabled: instance.enabled,
    last_seen_at: instance.last_seen_at,
    last_error: instance.last_error,
    runtime_warning: instance.runtime_warning,
    invite_url: botInviteUrl(instance.bot_client_id, instance.guild_id)
  };
}

async function discord(pathname, token, bot = false) {
  const response = await fetch(`https://discord.com/api/v10${pathname}`, {
    headers: { Authorization: `${bot ? 'Bot' : 'Bearer'} ${token}` }
  });
  if (!response.ok) throw Object.assign(new Error(`Discord API respondeu ${response.status}`), { status: response.status });
  return response.json();
}

async function discordJson(pathname, token, body) {
  const response = await fetch(`https://discord.com/api/v10${pathname}`, {
    method: 'POST',
    headers: {
      Authorization: `Bot ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.message || `Discord API respondeu ${response.status}`), { status: response.status });
  return data;
}

async function syncGuildResources(instance) {
  const token = decrypt(instance.token_encrypted);
  const [guild, channelsRaw, rolesRaw] = await Promise.all([
    discord(`/guilds/${instance.guild_id}`, token, true),
    discord(`/guilds/${instance.guild_id}/channels`, token, true),
    discord(`/guilds/${instance.guild_id}/roles`, token, true)
  ]);
  const textChannelTypes = new Set([0, 5, 10, 11, 12, 15]);
  const channels = (Array.isArray(channelsRaw) ? channelsRaw : [])
    .filter((channel) => textChannelTypes.has(Number(channel.type)))
    .map((channel) => ({
      id: channel.id,
      name: channel.name,
      type: channel.type,
      parent_id: channel.parent_id || null
    }))
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  const roles = (Array.isArray(rolesRaw) ? rolesRaw : [])
    .filter((role) => !role.managed && role.name !== '@everyone')
    .map((role) => ({
      id: role.id,
      name: role.name,
      color: role.color
    }))
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));

  const saved = await one(`
    insert into guild_resources (bot_instance_id,channels,roles,updated_at)
    values ($1,$2::jsonb,$3::jsonb,now())
    on conflict (bot_instance_id) do update set
      channels=excluded.channels,
      roles=excluded.roles,
      updated_at=now()
    returning *
  `, [instance.id, JSON.stringify(channels), JSON.stringify(roles)]);
  await query(
    'update bot_instances set guild_name=$1,last_error=null,updated_at=now() where id=$2',
    [guild.name || instance.guild_name || 'Servidor', instance.id]
  );
  return saved || { channels, roles, updated_at: new Date().toISOString() };
}

async function session(req) {
  authReady();
  const payload = readCookie(req);
  if (!payload) return null;
  try {
    const data = decodeSession(payload);
    if (!data?.expires_at || new Date(data.expires_at).getTime() <= Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

async function requireSession(req, res) {
  const data = await session(req);
  if (!data) {
    res.status(401).json({ error: 'login_required' });
    return null;
  }
  return data;
}

async function getInstance(id, ownerDiscordId) {
  return one('select * from bot_instances where id = $1 and owner_discord_id = $2', [id, ownerDiscordId]);
}

async function ensureSettingsSchema() {
  await query(`
    alter table bot_settings
      add column if not exists ticket_open_color text not null default '#5865f2',
      add column if not exists ticket_open_title text not null default 'Novo atendimento de {user}',
      add column if not exists ticket_open_message text not null default 'Ola {user}, obrigado por abrir um ticket.\n\nExplique aqui o que voce precisa e aguarde o suporte. {supportRoleMentions}',
      add column if not exists ticket_open_purchase_title text not null default 'Novo pedido de {user}',
      add column if not exists ticket_open_purchase_message text not null default 'ID do pedido: **gerando**\nProduto: **{product}**\nPreco: **{price}**\n\nAguarde o suporte aprovar sua compra.'
  `);
}

async function ensureSettings(instanceId) {
  await ensureSettingsSchema();
  await query('insert into bot_settings (bot_instance_id) values ($1) on conflict (bot_instance_id) do nothing', [instanceId]);
  return one('select * from bot_settings where bot_instance_id = $1', [instanceId]);
}

async function ensurePayment(instanceId) {
  await ensureCommerceSchema();
  await query('insert into payment_settings (bot_instance_id) values ($1) on conflict (bot_instance_id) do nothing', [instanceId]);
  return one('select * from payment_settings where bot_instance_id = $1', [instanceId]);
}

async function ensureCommerceSchema() {
  await query(`
    alter table products
      add column if not exists product_type text not null default 'single',
      add column if not exists variations jsonb not null default '[]'::jsonb,
      add column if not exists stock integer,
      add column if not exists delivery_content text,
      add column if not exists low_stock_notified boolean not null default false
  `);
  await query(`
    create table if not exists payment_settings (
      bot_instance_id uuid primary key references bot_instances(id) on delete cascade,
      provider text not null default 'aurora',
      checkout_mode text not null default 'ticket',
      receiver_name text,
      public_instructions text,
      private_details_encrypted text,
      updated_at timestamptz not null default now()
    )
  `);
  await query(`
    alter table payment_settings
      add column if not exists terms_text text not null default 'Ao confirmar, voce declara que revisou os produtos, valores e entende que a entrega ocorre apos aprovacao do pagamento.',
      add column if not exists pix_city text not null default 'SAO PAULO'
  `);
  await query("alter table payment_settings alter column provider set default 'aurora'");
  await query(`
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
    )
  `);
  await query('alter table tickets add column if not exists payment_order_id uuid references payment_orders(id) on delete set null');
  await query('alter table payment_settings enable row level security');
  await query('alter table payment_orders enable row level security');
}

app.get('/app.css', (_, res) => res.sendFile(path.join(publicDir, 'app.css')));
app.get('/app.js', (_, res) => res.type('application/javascript').sendFile(path.join(publicDir, 'app.js')));

app.get('/', async (req, res, next) => {
  try {
    const user = await session(req);
    if (!user) return res.redirect('/auth/discord');
    return res.sendFile(path.join(publicDir, 'app.html'));
  } catch (error) {
    return next(error);
  }
});

app.get('/auth/discord', (req, res, next) => {
  try {
    authReady();
    return passport.authenticate('discord', { session: false })(req, res, next);
  } catch (error) {
    return next(error);
  }
});

app.get('/auth/discord/callback', passport.authenticate('discord', {
  session: false,
  failureRedirect: '/'
}), async (req, res, next) => {
  try {
    authReady();
    const sessionPayload = encodeSession({
      discord_id: req.user.id,
      username: req.user.username,
      avatar: req.user.avatar,
      access_token: req.user.accessToken,
      expires_at: new Date(Date.now() + week * 1000).toISOString()
    });
    setCookie(res, sessionPayload);
    return res.redirect('/');
  } catch (error) {
    return next(error);
  }
});

app.get('/logout', (_, res) => {
  clearCookie(res);
  res.redirect('/');
});

app.get('/api/me', async (req, res, next) => {
  try {
    const user = await requireSession(req, res);
    if (!user) return;
    res.json({ id: user.discord_id, username: user.username, avatar: user.avatar });
  } catch (error) {
    next(error);
  }
});

app.get('/api/guilds', async (req, res, next) => {
  try {
    const user = await requireSession(req, res);
    if (!user) return;
    const guilds = (await discord('/users/@me/guilds', user.access_token)).filter(hasManageGuild);
    const instances = await query(
      'select id,guild_id,guild_name,bot_name,bot_client_id,enabled,last_seen_at,last_error,runtime_warning from bot_instances where owner_discord_id = $1',
      [user.discord_id]
    );
    const byGuild = new Map(instances.map((item) => [item.guild_id, item]));
    const list = guilds.map((guild) => ({
      id: guild.id,
      name: guild.name,
      icon: guild.icon,
      savedOnly: false,
      instance: publicInstance(byGuild.get(guild.id))
    }));
    const listedGuilds = new Set(list.map((guild) => guild.id));
    instances
      .filter((instance) => !listedGuilds.has(instance.guild_id))
      .forEach((instance) => list.push({
        id: instance.guild_id,
        name: instance.guild_name || instance.bot_name || 'Servidor salvo',
        icon: null,
        savedOnly: true,
        instance: publicInstance(instance)
      }));
    res.json(list);
  } catch (error) {
    next(error);
  }
});

app.get('/api/instances', async (req, res, next) => {
  try {
    const user = await requireSession(req, res);
    if (!user) return;
    const instances = await query(
      'select id,guild_id,guild_name,bot_name,bot_client_id,enabled,last_seen_at,last_error,runtime_warning from bot_instances where owner_discord_id = $1 order by updated_at desc nulls last, created_at desc nulls last',
      [user.discord_id]
    );
    res.json(instances.map(publicInstance));
  } catch (error) {
    next(error);
  }
});

app.post('/api/instances', async (req, res, next) => {
  try {
    const user = await requireSession(req, res);
    if (!user) return;
    const guildId = snowflake(req.body.guildId);
    const guildName = text(req.body.guildName || 'Servidor', 100);
    const botName = text(req.body.botName || 'Aurora Sales', 80);
    const token = text(req.body.token, 300);
    if (!guildId) return res.status(400).json({ error: 'guild_required' });

    const existing = await one('select * from bot_instances where owner_discord_id = $1 and guild_id = $2', [user.discord_id, guildId]);
    if (!existing && !token) return res.status(400).json({ error: 'token_required' });

    let tokenEncrypted = existing?.token_encrypted || null;
    let lastError = null;
    let botClientId = existing?.bot_client_id || null;
    let enabled = existing?.enabled ?? false;
    if (token) {
      try {
        const botUser = await discord('/users/@me', token, true);
        botClientId = botUser.id || botClientId;
        enabled = true;
      } catch {
        lastError = 'Token invalido ou bot sem acesso.';
        enabled = false;
      }
      tokenEncrypted = encrypt(token);
    }

    const saved = await one(`
      insert into bot_instances (owner_discord_id,guild_id,guild_name,bot_name,bot_client_id,token_encrypted,enabled,last_error,updated_at)
      values ($1,$2,$3,$4,$5,$6,$7,$8,now())
      on conflict (owner_discord_id,guild_id)
      do update set guild_name = excluded.guild_name, bot_name = excluded.bot_name,
        bot_client_id = excluded.bot_client_id, token_encrypted = excluded.token_encrypted,
        enabled = excluded.enabled, last_error = excluded.last_error, updated_at = now()
      returning id,guild_id,guild_name,bot_name,bot_client_id,enabled,last_seen_at,last_error,runtime_warning
    `, [user.discord_id, guildId, guildName, botName, botClientId, tokenEncrypted, enabled, lastError]);
    await ensureSettings(saved.id);
    res.json(publicInstance(saved));
  } catch (error) {
    next(error);
  }
});

app.post('/api/instances/:id/enabled', async (req, res, next) => {
  try {
    const user = await requireSession(req, res);
    if (!user) return;
    const instance = await getInstance(req.params.id, user.discord_id);
    if (!instance) return res.status(404).json({ error: 'not_found' });
    const saved = await one(`
      update bot_instances set enabled = $1, last_error = null, updated_at = now()
      where id = $2
      returning id,guild_id,guild_name,bot_name,bot_client_id,enabled,last_seen_at,last_error,runtime_warning
    `, [Boolean(req.body.enabled), instance.id]);
    res.json(publicInstance(saved));
  } catch (error) {
    next(error);
  }
});

app.get('/api/instances/:id/resources', async (req, res, next) => {
  try {
    const user = await requireSession(req, res);
    if (!user) return;
    const instance = await getInstance(req.params.id, user.discord_id);
    if (!instance) return res.status(404).json({ error: 'not_found' });
    const data = await one('select * from guild_resources where bot_instance_id = $1', [instance.id]);
    const roles = Array.isArray(data?.roles) ? data.roles : [];
    const channels = Array.isArray(data?.channels) ? data.channels : [];
    const staleOrEmpty = !data || !roles.length || !channels.length;
    if (staleOrEmpty && instance.token_encrypted) {
      try {
        return res.json(await syncGuildResources(instance));
      } catch {
        return res.json(data || { channels: [], roles: [], updated_at: null });
      }
    }
    res.json(data || { channels: [], roles: [], updated_at: null });
  } catch (error) {
    next(error);
  }
});

app.post('/api/instances/:id/resources/sync', async (req, res, next) => {
  try {
    const user = await requireSession(req, res);
    if (!user) return;
    const instance = await getInstance(req.params.id, user.discord_id);
    if (!instance) return res.status(404).json({ error: 'not_found' });
    if (!instance.token_encrypted) return res.status(400).json({ error: 'token_required', message: 'Salve o token do bot antes de buscar cargos e canais.' });
    try {
      const data = await syncGuildResources(instance);
      res.json(data);
    } catch (error) {
      const message = /403|404/.test(String(error.status || error.message))
        ? 'Adicione o bot ao servidor selecionado e garanta permissao para Ver Canais/Gerenciar Cargos.'
        : error.message;
      await query('update bot_instances set last_error=$1,updated_at=now() where id=$2', [String(message).slice(0, 500), instance.id]);
      res.status(error.status && Number(error.status) >= 400 ? Number(error.status) : 400).json({ error: 'resource_sync_failed', message });
    }
  } catch (error) {
    next(error);
  }
});

app.get('/api/instances/:id/settings', async (req, res, next) => {
  try {
    const user = await requireSession(req, res);
    if (!user) return;
    const instance = await getInstance(req.params.id, user.discord_id);
    if (!instance) return res.status(404).json({ error: 'not_found' });
    await ensureCommerceSchema();
    const settings = await ensureSettings(instance.id);
    const products = await query('select * from products where bot_instance_id = $1 order by created_at desc', [instance.id]);
    const payment = publicPayment(await ensurePayment(instance.id));
    res.json({ settings, products, payment });
  } catch (error) {
    next(error);
  }
});

app.put('/api/instances/:id/settings', async (req, res, next) => {
  try {
    const user = await requireSession(req, res);
    if (!user) return;
    const instance = await getInstance(req.params.id, user.discord_id);
    if (!instance) return res.status(404).json({ error: 'not_found' });
    await ensureSettingsSchema();
    const body = req.body || {};
    const values = [
      instance.id,
      text(body.brand_name || 'Aurora Store', 80),
      /^#[0-9a-f]{6}$/i.test(body.brand_color || '') ? body.brand_color : '#5865f2',
      snowflake(body.auto_role_id),
      snowflake(body.verified_role_id),
      Boolean(body.remove_auto_role_after_verify),
      snowflake(body.welcome_channel_id),
      messageMode(body.welcome_mode),
      hexColor(body.welcome_color, hexColor(body.brand_color)),
      text(body.welcome_title || 'Novo membro', 100),
      text(body.welcome_message || '', 1500),
      snowflake(body.auth_channel_id),
      messageMode(body.auth_mode),
      hexColor(body.auth_color, hexColor(body.brand_color)),
      text(body.auth_title || 'Autenticacao', 100),
      text(body.auth_message || '', 1500),
      text(body.auth_button_label || 'Verificar acesso', 80),
      snowflake(body.ticket_channel_id),
      json(arrayOfSnowflakes(body.support_role_ids)),
      messageMode(body.ticket_mode),
      hexColor(body.ticket_color, hexColor(body.brand_color)),
      text(body.ticket_title || 'Atendimento', 100),
      text(body.ticket_message || '', 1500),
      text(body.ticket_button_label || 'Abrir ticket', 80),
      hexColor(body.ticket_open_color, hexColor(body.ticket_color, hexColor(body.brand_color))),
      text(body.ticket_open_title || 'Novo atendimento de {user}', 100),
      text(body.ticket_open_message || '', 2500),
      text(body.ticket_open_purchase_title || 'Novo pedido de {user}', 100),
      text(body.ticket_open_purchase_message || '', 2500),
      snowflake(body.sales_channel_id),
      messageMode(body.sales_mode),
      hexColor(body.sales_color, hexColor(body.brand_color)),
      text(body.sales_title || 'Vitrine', 100),
      text(body.sales_message || '', 1500),
      deliveryMode(body.delivery_mode),
      text(body.delivery_title || 'Compra aprovada', 100),
      text(body.delivery_message || '', 2500),
      hexColor(body.delivery_color, '#58e39b'),
      snowflake(body.review_channel_id),
      text(body.review_title || 'Nova avaliacao', 100),
      text(body.review_message || '', 1500),
      hexColor(body.review_color, '#ffcc4d'),
      text(body.review_gif_url, 300),
      snowflake(body.log_channel_id),
      integerOrNull(body.stock_warn_threshold, 0, 999999) ?? 3,
      text(body.button_emoji || '', 120)
    ];
    const saved = await one(`
      insert into bot_settings (
        bot_instance_id,brand_name,brand_color,auto_role_id,verified_role_id,remove_auto_role_after_verify,
        welcome_channel_id,welcome_mode,welcome_color,welcome_title,welcome_message,
        auth_channel_id,auth_mode,auth_color,auth_title,auth_message,auth_button_label,
        ticket_channel_id,support_role_ids,ticket_mode,ticket_color,ticket_title,ticket_message,ticket_button_label,
        ticket_open_color,ticket_open_title,ticket_open_message,ticket_open_purchase_title,ticket_open_purchase_message,
        sales_channel_id,sales_mode,sales_color,sales_title,sales_message,
        delivery_mode,delivery_title,delivery_message,delivery_color,
        review_channel_id,review_title,review_message,review_color,review_gif_url,
        log_channel_id,stock_warn_threshold,button_emoji,updated_at
      ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40,$41,$42,$43,$44,$45,$46,now())
      on conflict (bot_instance_id) do update set
        brand_name=excluded.brand_name, brand_color=excluded.brand_color, auto_role_id=excluded.auto_role_id,
        verified_role_id=excluded.verified_role_id, remove_auto_role_after_verify=excluded.remove_auto_role_after_verify,
        welcome_channel_id=excluded.welcome_channel_id, welcome_mode=excluded.welcome_mode,
        welcome_color=excluded.welcome_color, welcome_title=excluded.welcome_title, welcome_message=excluded.welcome_message,
        auth_channel_id=excluded.auth_channel_id, auth_mode=excluded.auth_mode, auth_color=excluded.auth_color,
        auth_title=excluded.auth_title, auth_message=excluded.auth_message,
        auth_button_label=excluded.auth_button_label, ticket_channel_id=excluded.ticket_channel_id,
        support_role_ids=excluded.support_role_ids, ticket_mode=excluded.ticket_mode, ticket_color=excluded.ticket_color,
        ticket_title=excluded.ticket_title, ticket_message=excluded.ticket_message,
        ticket_button_label=excluded.ticket_button_label,
        ticket_open_color=excluded.ticket_open_color, ticket_open_title=excluded.ticket_open_title,
        ticket_open_message=excluded.ticket_open_message, ticket_open_purchase_title=excluded.ticket_open_purchase_title,
        ticket_open_purchase_message=excluded.ticket_open_purchase_message,
        sales_channel_id=excluded.sales_channel_id,
        sales_mode=excluded.sales_mode, sales_color=excluded.sales_color, sales_title=excluded.sales_title,
        sales_message=excluded.sales_message, delivery_mode=excluded.delivery_mode,
        delivery_title=excluded.delivery_title, delivery_message=excluded.delivery_message,
        delivery_color=excluded.delivery_color, review_channel_id=excluded.review_channel_id,
        review_title=excluded.review_title, review_message=excluded.review_message,
        review_color=excluded.review_color, review_gif_url=excluded.review_gif_url,
        log_channel_id=excluded.log_channel_id, stock_warn_threshold=excluded.stock_warn_threshold,
        button_emoji=excluded.button_emoji, updated_at=now()
      returning *
    `, values);
    res.json(saved);
  } catch (error) {
    next(error);
  }
});

app.post('/api/instances/:id/emoji', async (req, res, next) => {
  try {
    const user = await requireSession(req, res);
    if (!user) return;
    const instance = await getInstance(req.params.id, user.discord_id);
    if (!instance) return res.status(404).json({ error: 'not_found' });
    const image = text(req.body.image, 750000);
    const name = emojiName(req.body.name);
    if (!image.startsWith('data:image/')) return res.status(400).json({ error: 'invalid_image' });
    await ensureSettings(instance.id);
    const created = await discordJson(`/guilds/${instance.guild_id}/emojis`, decrypt(instance.token_encrypted), { name, image });
    const emojiText = created.animated ? `<a:${created.name}:${created.id}>` : `<:${created.name}:${created.id}>`;
    const saved = await one(`
      update bot_settings set custom_emoji_id=$1, custom_emoji_name=$2, custom_emoji_animated=$3, button_emoji=$4, updated_at=now()
      where bot_instance_id=$5
      returning *
    `, [created.id, created.name, Boolean(created.animated), emojiText, instance.id]);
    res.json({ emoji: emojiText, settings: saved || await ensureSettings(instance.id) });
  } catch (error) {
    next(error);
  }
});

app.post('/api/instances/:id/products', async (req, res, next) => {
  try {
    const user = await requireSession(req, res);
    if (!user) return;
    const instance = await getInstance(req.params.id, user.discord_id);
    if (!instance) return res.status(404).json({ error: 'not_found' });
    await ensureCommerceSchema();
    const name = text(req.body.name, 80);
    const type = productType(req.body.product_type);
    const variations = productVariations(req.body.variations);
    const price = type === 'variation' ? (variations[0]?.price || '') : text(req.body.price, 50);
    if (!name) return res.status(400).json({ error: 'name_required', message: 'Digite o nome do produto.' });
    if (type === 'single' && !price) return res.status(400).json({ error: 'price_required', message: 'Digite o preco do produto unico.' });
    if (type === 'variation' && !variations.length) return res.status(400).json({ error: 'variations_required', message: 'Cadastre pelo menos uma variacao no formato: 1 dia | R$ 5,00 | descricao opcional.' });
    const saved = await one(`
      insert into products (bot_instance_id,guild_id,name,price,product_type,variations,stock,delivery_content,description,image_url,active)
      values ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11) returning *
    `, [
      instance.id,
      instance.guild_id,
      name,
      price,
      type,
      json(variations),
      integerOrNull(req.body.stock, 0, 999999),
      text(req.body.delivery_content, 5000),
      text(req.body.description, 1000),
      text(req.body.image_url, 300),
      req.body.active !== false
    ]);
    res.json(saved);
  } catch (error) {
    next(error);
  }
});

app.get('/api/instances/:id/logs', async (req, res, next) => {
  try {
    const user = await requireSession(req, res);
    if (!user) return;
    const instance = await getInstance(req.params.id, user.discord_id);
    if (!instance) return res.status(404).json({ error: 'not_found' });
    const logs = await query(`
      select id,event_type,actor_id,target_id,channel_id,message,metadata,created_at
      from bot_logs
      where bot_instance_id=$1
      order by created_at desc
      limit 150
    `, [instance.id]);
    res.json({ logs });
  } catch (error) {
    next(error);
  }
});

app.put('/api/instances/:id/payment', async (req, res, next) => {
  try {
    const user = await requireSession(req, res);
    if (!user) return;
    const instance = await getInstance(req.params.id, user.discord_id);
    if (!instance) return res.status(404).json({ error: 'not_found' });
    const body = req.body || {};
    const existing = await ensurePayment(instance.id);
    const rawPrivate = text(body.private_details, 300);
    const encryptedPrivate = rawPrivate ? encrypt(rawPrivate) : existing.private_details_encrypted;
    const saved = await one(`
      insert into payment_settings (
        bot_instance_id,provider,checkout_mode,receiver_name,public_instructions,private_details_encrypted,terms_text,pix_city,updated_at
      ) values ($1,$2,$3,$4,$5,$6,$7,$8,now())
      on conflict (bot_instance_id) do update set
        provider=excluded.provider,
        checkout_mode=excluded.checkout_mode,
        receiver_name=excluded.receiver_name,
        public_instructions=excluded.public_instructions,
        private_details_encrypted=excluded.private_details_encrypted,
        terms_text=excluded.terms_text,
        pix_city=excluded.pix_city,
        updated_at=now()
      returning *
    `, [
      instance.id,
      paymentProvider(body.provider),
      checkoutMode(body.checkout_mode),
      text(body.receiver_name, 120),
      text(body.public_instructions, 1500),
      encryptedPrivate,
      text(body.terms_text || 'Ao confirmar, voce declara que revisou os produtos, valores e entende que a entrega ocorre apos aprovacao do pagamento.', 2500),
      text(body.pix_city || 'SAO PAULO', 15)
    ]);
    res.json(publicPayment(saved));
  } catch (error) {
    next(error);
  }
});

app.delete('/api/instances/:id/products/:productId', async (req, res, next) => {
  try {
    const user = await requireSession(req, res);
    if (!user) return;
    const instance = await getInstance(req.params.id, user.discord_id);
    if (!instance) return res.status(404).json({ error: 'not_found' });
    await query('delete from products where id = $1 and bot_instance_id = $2', [req.params.productId, instance.id]);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get('/health', (_, res) => {
  res.json({
    version,
    ok: missing(['CLIENT_ID', 'CLIENT_SECRET', 'REDIRECT_URI', 'SESSION_SECRET', 'BOT_ENCRYPTION_KEY', 'DATABASE_URL']).length === 0 && key.length === 32,
    missing: missing(['CLIENT_ID', 'CLIENT_SECRET', 'REDIRECT_URI', 'SESSION_SECRET', 'BOT_ENCRYPTION_KEY', 'DATABASE_URL']),
    keyBytes: key.length
  });
});

app.get('/health/oauth', (_, res) => {
  const redirectUri = env('REDIRECT_URI');
  const clientId = env('CLIENT_ID');
  const params = new URLSearchParams({
    client_id: clientId || 'missing',
    redirect_uri: redirectUri || 'missing',
    response_type: 'code',
    scope: 'identify guilds'
  });
  res.json({
    version,
    clientId,
    redirectUri,
    redirectUriLength: redirectUri.length,
    expectedRedirectUri: 'https://aurora-vercel-dashboard.vercel.app/auth/discord/callback',
    exactMatchExpected: redirectUri === 'https://aurora-vercel-dashboard.vercel.app/auth/discord/callback',
    discordAuthorizeUrl: `https://discord.com/oauth2/authorize?${params.toString()}`
  });
});

app.get('/health/db', async (_, res) => {
  try {
    dbReady();
    const result = await pool.query('select to_regclass($1) as bot_instances', ['public.bot_instances']);
    res.json({ version, ok: true, database: 'connected', bot_instances: result.rows[0].bot_instances });
  } catch (error) {
    res.status(500).json({ version, ok: false, message: error.message });
  }
});

app.use((error, req, res, _next) => {
  const status = error.status && Number(error.status) >= 400 ? Number(error.status) : 500;
  if (String(req.headers.accept || '').includes('text/html')) {
    return res.status(status).type('html').send(`<!doctype html><meta charset="utf-8"><title>Aurora erro</title><body style="background:#070912;color:#fff;font-family:system-ui;padding:40px"><h1>Aurora encontrou um erro</h1><pre>${String(error.message || 'Erro inesperado')}</pre><p>Teste /health e /health/db.</p></body>`);
  }
  res.status(status).json({ error: status === 500 ? 'internal_error' : 'request_error', message: error.message || 'Erro inesperado' });
});

export default app;
