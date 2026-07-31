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
const botPermissions = 344208523344n;

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

async function ensureSettings(instanceId) {
  await query('insert into bot_settings (bot_instance_id) values ($1) on conflict (bot_instance_id) do nothing', [instanceId]);
  return one('select * from bot_settings where bot_instance_id = $1', [instanceId]);
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
    const settings = await ensureSettings(instance.id);
    const products = await query('select * from products where bot_instance_id = $1 order by created_at desc', [instance.id]);
    res.json({ settings, products });
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
      snowflake(body.sales_channel_id),
      messageMode(body.sales_mode),
      hexColor(body.sales_color, hexColor(body.brand_color)),
      text(body.sales_title || 'Vitrine', 100),
      text(body.sales_message || '', 1500),
      text(body.button_emoji || '', 120)
    ];
    const saved = await one(`
      insert into bot_settings (
        bot_instance_id,brand_name,brand_color,auto_role_id,verified_role_id,remove_auto_role_after_verify,
        welcome_channel_id,welcome_mode,welcome_color,welcome_title,welcome_message,
        auth_channel_id,auth_mode,auth_color,auth_title,auth_message,auth_button_label,
        ticket_channel_id,support_role_ids,ticket_mode,ticket_color,ticket_title,ticket_message,ticket_button_label,
        sales_channel_id,sales_mode,sales_color,sales_title,sales_message,button_emoji,updated_at
      ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,now())
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
        ticket_button_label=excluded.ticket_button_label, sales_channel_id=excluded.sales_channel_id,
        sales_mode=excluded.sales_mode, sales_color=excluded.sales_color, sales_title=excluded.sales_title,
        sales_message=excluded.sales_message, button_emoji=excluded.button_emoji, updated_at=now()
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
    const name = text(req.body.name, 80);
    const price = text(req.body.price, 50);
    if (!name || !price) return res.status(400).json({ error: 'name_and_price_required' });
    const saved = await one(`
      insert into products (bot_instance_id,name,price,description,image_url,active)
      values ($1,$2,$3,$4,$5,$6) returning *
    `, [instance.id, name, price, text(req.body.description, 1000), text(req.body.image_url, 300), req.body.active !== false]);
    res.json(saved);
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
