import 'dotenv/config';
import crypto from 'node:crypto';
import {
  ActionRowBuilder,
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

const { Pool } = pg;
const env = (name) => String(process.env[name] || '').trim();
for (const name of ['DATABASE_URL', 'BOT_ENCRYPTION_KEY']) {
  if (!env(name)) throw new Error(`${name} nao configurada.`);
}
const pool = new Pool({ connectionString: env('DATABASE_URL'), ssl: { rejectUnauthorized: false }, max: 5 });
const key = Buffer.from(env('BOT_ENCRYPTION_KEY'), 'base64');
if (key.length !== 32) throw new Error('BOT_ENCRYPTION_KEY deve ser Base64 de 32 bytes.');
const pollInterval = Math.max(Number(env('POLL_INTERVAL_MS')) || 8000, 3000);
const runnerName = env('RUNNER_NAME') || 'aurora-zero-runner';

const running = new Map();
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

function embed(settings, title, description) {
  return new EmbedBuilder()
    .setColor(/^#[0-9a-f]{6}$/i.test(settings.brand_color || '') ? settings.brand_color : '#5865f2')
    .setTitle(title || settings.brand_name || 'Aurora')
    .setDescription(description || '')
    .setFooter({ text: settings.brand_name || 'Aurora Store' });
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
    ticket: context.thread ? `<#${context.thread.id}>` : '',
    ticketId: context.thread?.id || '',
    emoji: settings.button_emoji || '',
    date: now.toLocaleDateString('pt-BR'),
    time: now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
  };
  return String(template || '').replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key) => vars[key] ?? '');
}

async function setError(id, message) {
  await query('update bot_instances set last_error=$1, last_seen_at=null, updated_at=now() where id=$2', [String(message || '').slice(0, 500), id]);
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

async function sync(instance, client) {
  const guild = client.guilds.cache.get(instance.guild_id);
  if (!guild) {
    await setError(instance.id, 'Esse bot ainda nao esta no servidor selecionado.');
    return;
  }
  await guild.channels.fetch().catch(() => null);
  await guild.roles.fetch().catch(() => null);
  const channels = [...guild.channels.cache.values()]
    .filter((channel) => channel?.isTextBased?.() && channel.type !== ChannelType.DM)
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
  await query('update bot_instances set guild_name=$1,last_seen_at=now(),last_error=null,updated_at=now() where id=$2', [guild.name, instance.id]);
  await guild.commands.set(commands);
}

async function panel(instanceId, type, context = {}) {
  const settings = await getSettings(instanceId);
  context.settings = settings;
  if (type === 'auth') {
    return {
      embeds: [embed(settings, renderTemplate(settings.auth_title, context), renderTemplate(settings.auth_message, context))],
      components: [row(btn('az:auth', renderTemplate(settings.auth_button_label, context), ButtonStyle.Success, settings.button_emoji))]
    };
  }
  if (type === 'ticket') {
    return {
      embeds: [embed(settings, renderTemplate(settings.ticket_title, context), renderTemplate(settings.ticket_message, context))],
      components: [row(btn('az:ticket', renderTemplate(settings.ticket_button_label, context), ButtonStyle.Primary, settings.button_emoji))]
    };
  }
  const items = await products(instanceId);
  const rows = [];
  items.slice(0, 25).forEach((item, index) => {
    const n = Math.floor(index / 5);
    rows[n] ||= new ActionRowBuilder();
    rows[n].addComponents(btn(`az:buy:${item.id}`, renderTemplate(item.name, { ...context, product: item }), ButtonStyle.Success, settings.button_emoji));
  });
  return { embeds: [embed(settings, renderTemplate(settings.sales_title, context), renderTemplate(settings.sales_message, context))], components: rows };
}

async function addTicketMembers(thread, interaction, settings) {
  await thread.members.add(interaction.user.id).catch(() => null);
  if (interaction.guild.ownerId) await thread.members.add(interaction.guild.ownerId).catch(() => null);
  const support = Array.isArray(settings.support_role_ids) ? settings.support_role_ids : [];
  if (!support.length) return;
  const members = await interaction.guild.members.fetch().catch(() => null);
  if (!members) return;
  await Promise.all(members
    .filter((member) => support.some((roleId) => member.roles.cache.has(roleId)))
    .map((member) => thread.members.add(member.id).catch(() => null)));
}

async function openTicket(interaction, instance, productId = null) {
  const settings = await getSettings(instance.id);
  const parent = await interaction.guild.channels.fetch(settings.ticket_channel_id || interaction.channelId).catch(() => null);
  if (!parent?.isTextBased?.()) return interaction.reply({ content: 'Canal base de tickets nao configurado.', ephemeral: true });
  const item = productId ? await product(instance.id, productId) : null;
  const thread = await parent.threads.create({
    name: `${item ? 'compra' : 'ticket'}-${interaction.user.username}`.slice(0, 95),
    type: ChannelType.PrivateThread,
    invitable: false
  });
  await addTicketMembers(thread, interaction, settings);
  await query(`
    insert into tickets (thread_id,bot_instance_id,guild_id,owner_id,product_id,status,closed_at)
    values ($1,$2,$3,$4,$5,'open',null)
    on conflict (thread_id) do update set status='open', closed_at=null
  `, [thread.id, instance.id, interaction.guildId, interaction.user.id, item?.id || null]);
  const mentions = (settings.support_role_ids || []).map((id) => `<@&${id}>`).join(' ');
  await thread.send({
    content: `${interaction.user} ${mentions}`.trim(),
    embeds: [embed(
      settings,
      renderTemplate(item ? 'Novo pedido de {user}' : 'Novo ticket de {user}', { interaction, settings, product: item, thread }),
      item
        ? renderTemplate(`Produto: **{product}**\nPreco: **{price}**\n{productDescription}`, { interaction, settings, product: item, thread })
        : renderTemplate('Ola {user}, descreva o atendimento. {supportRoleMentions}', { interaction, settings, thread })
    )],
    components: [row(btn('az:close', 'Fechar ticket', ButtonStyle.Danger, settings.button_emoji))]
  });
  return interaction.reply({ content: `Ticket criado: ${thread}`, ephemeral: true });
}

async function closeTicket(interaction, instance) {
  if (!interaction.channel?.isThread?.()) return interaction.reply({ content: 'Use dentro de um ticket.', ephemeral: true });
  const settings = await getSettings(instance.id);
  const ticket = await one('select * from tickets where thread_id=$1', [interaction.channel.id]);
  const support = Array.isArray(settings.support_role_ids) ? settings.support_role_ids : [];
  const allowed = ticket?.owner_id === interaction.user.id || interaction.memberPermissions?.has(PermissionFlagsBits.ManageThreads) || support.some((roleId) => interaction.member?.roles?.cache?.has(roleId));
  if (!allowed) return interaction.reply({ content: 'Apenas o autor ou suporte pode fechar.', ephemeral: true });
  await query("update tickets set status='closed', closed_at=now() where thread_id=$1", [interaction.channel.id]);
  await interaction.reply('Ticket fechado.');
  setTimeout(() => interaction.channel.setArchived(true).catch(() => null), 2500);
}

async function handle(interaction, instance) {
  if (instance.guild_id !== interaction.guildId) return;
  if (interaction.isChatInputCommand() && interaction.commandName === 'painel') {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return interaction.reply({ content: 'Voce precisa de Gerenciar Servidor.', ephemeral: true });
    const type = interaction.options.getString('tipo', true);
    const channel = interaction.options.getChannel('canal', true);
    const payload = await panel(instance.id, type, { interaction, channel });
    if (type === 'sales' && !payload.components.length) return interaction.reply({ content: 'Cadastre produtos no site antes de publicar.', ephemeral: true });
    await channel.send(payload);
    return interaction.reply({ content: `Painel publicado em ${channel}.`, ephemeral: true });
  }
  if (!interaction.isButton() || !interaction.customId.startsWith('az:')) return;
  const [, action, value] = interaction.customId.split(':');
  if (action === 'auth') {
    const settings = await getSettings(instance.id);
    if (!settings.verified_role_id) return interaction.reply({ content: 'Cargo verificado nao configurado.', ephemeral: true });
    await interaction.member.roles.add(settings.verified_role_id).catch(() => null);
    if (settings.remove_auto_role_after_verify && settings.auto_role_id) await interaction.member.roles.remove(settings.auto_role_id).catch(() => null);
    return interaction.reply({ content: 'Acesso liberado.', ephemeral: true });
  }
  if (action === 'ticket') return openTicket(interaction, instance);
  if (action === 'buy') return openTicket(interaction, instance, Number(value));
  if (action === 'close') return closeTicket(interaction, instance);
}

async function start(instance) {
  if (running.has(instance.id)) return;
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });
  client.once(Events.ClientReady, async () => {
    console.log(`[${runnerName}] Online: ${client.user.tag} / ${instance.guild_name}`);
    await sync(instance, client).catch((error) => setError(instance.id, error.message));
  });
  client.on(Events.Error, (error) => {
    console.error(`[${runnerName}] Discord client error (${instance.bot_name || instance.id}):`, error);
    setError(instance.id, error.message).catch(console.error);
  });
  client.on(Events.Warn, (warning) => console.warn(`[${runnerName}] Discord warning (${instance.bot_name || instance.id}):`, warning));
  client.on(Events.GuildCreate, () => sync(instance, client).catch((error) => setError(instance.id, error.message)));
  client.on(Events.GuildMemberAdd, async (member) => {
    if (member.guild.id !== instance.guild_id) return;
    const settings = await getSettings(instance.id);
    if (settings.auto_role_id) await member.roles.add(settings.auto_role_id).catch(() => null);
    if (!settings.welcome_channel_id) return;
    const channel = await member.guild.channels.fetch(settings.welcome_channel_id).catch(() => null);
    if (!channel?.isTextBased?.()) return;
    await channel.send({
      embeds: [embed(
        settings,
        renderTemplate(settings.welcome_title, { member, settings, channel }),
        renderTemplate(settings.welcome_message, { member, settings, channel })
      )]
    }).catch(() => null);
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
  try {
    await client.login(decrypt(instance.token_encrypted));
    running.set(instance.id, client);
  } catch (error) {
    await setError(instance.id, error.message);
  }
}

async function stop(id) {
  const client = running.get(id);
  if (!client) return;
  client.destroy();
  running.delete(id);
}

async function reconcile() {
  const data = await query('select * from bot_instances where enabled=true');
  const ids = new Set((data || []).map((item) => item.id));
  for (const instance of data || []) await start(instance);
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
await reconcile();
setInterval(() => reconcile().catch((error) => console.error(error)), pollInterval);
