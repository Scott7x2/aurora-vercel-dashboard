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
import { createClient } from '@supabase/supabase-js';

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const key = Buffer.from(process.env.BOT_ENCRYPTION_KEY || '', 'base64');
if (key.length !== 32) throw new Error('BOT_ENCRYPTION_KEY deve ser Base64 de 32 bytes.');

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

function decrypt(value) {
  const [iv, data, tag] = value.split('.').map((part) => Buffer.from(part, 'base64'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

function row(...items) {
  return new ActionRowBuilder().addComponents(...items);
}

function btn(id, label, style) {
  return new ButtonBuilder().setCustomId(id).setLabel(String(label || 'Abrir').slice(0, 80)).setStyle(style);
}

function embed(settings, title, description) {
  return new EmbedBuilder()
    .setColor(/^#[0-9a-f]{6}$/i.test(settings.brand_color || '') ? settings.brand_color : '#5865f2')
    .setTitle(title || settings.brand_name || 'Aurora')
    .setDescription(description || '')
    .setFooter({ text: settings.brand_name || 'Aurora Store' });
}

async function setError(id, message) {
  await db.from('bot_instances').update({ last_error: message, last_seen_at: null }).eq('id', id);
}

async function getSettings(instanceId) {
  await db.from('bot_settings').upsert({ bot_instance_id: instanceId }, { onConflict: 'bot_instance_id', ignoreDuplicates: true });
  const { data, error } = await db.from('bot_settings').select('*').eq('bot_instance_id', instanceId).single();
  if (error) throw error;
  return data;
}

async function products(instanceId) {
  const { data, error } = await db.from('products').select('*').eq('bot_instance_id', instanceId).eq('active', true).order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

async function product(instanceId, id) {
  const { data, error } = await db.from('products').select('*').eq('bot_instance_id', instanceId).eq('id', id).maybeSingle();
  if (error) throw error;
  return data;
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

  await db.from('guild_resources').upsert({ bot_instance_id: instance.id, channels, roles, updated_at: new Date().toISOString() }, { onConflict: 'bot_instance_id' });
  await db.from('bot_instances').update({ guild_name: guild.name, last_seen_at: new Date().toISOString(), last_error: null }).eq('id', instance.id);
  await guild.commands.set(commands);
}

async function panel(instanceId, type) {
  const settings = await getSettings(instanceId);
  if (type === 'auth') {
    return {
      embeds: [embed(settings, settings.auth_title, settings.auth_message)],
      components: [row(btn('az:auth', settings.auth_button_label, ButtonStyle.Success))]
    };
  }
  if (type === 'ticket') {
    return {
      embeds: [embed(settings, settings.ticket_title, settings.ticket_message)],
      components: [row(btn('az:ticket', settings.ticket_button_label, ButtonStyle.Primary))]
    };
  }
  const items = await products(instanceId);
  const rows = [];
  items.slice(0, 25).forEach((item, index) => {
    const n = Math.floor(index / 5);
    rows[n] ||= new ActionRowBuilder();
    rows[n].addComponents(btn(`az:buy:${item.id}`, item.name, ButtonStyle.Success));
  });
  return { embeds: [embed(settings, settings.sales_title, settings.sales_message)], components: rows };
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
  await db.from('tickets').upsert({
    thread_id: thread.id,
    bot_instance_id: instance.id,
    guild_id: interaction.guildId,
    owner_id: interaction.user.id,
    product_id: item?.id || null,
    status: 'open',
    closed_at: null
  }, { onConflict: 'thread_id' });
  const mentions = (settings.support_role_ids || []).map((id) => `<@&${id}>`).join(' ');
  await thread.send({
    content: `${interaction.user} ${mentions}`.trim(),
    embeds: [embed(settings, item ? 'Novo pedido' : 'Novo ticket', item ? `Produto: **${item.name}**\nPreco: **${item.price}**\n${item.description || ''}` : `Ola ${interaction.user}, descreva o atendimento.`)],
    components: [row(btn('az:close', 'Fechar ticket', ButtonStyle.Danger))]
  });
  return interaction.reply({ content: `Ticket criado: ${thread}`, ephemeral: true });
}

async function closeTicket(interaction, instance) {
  if (!interaction.channel?.isThread?.()) return interaction.reply({ content: 'Use dentro de um ticket.', ephemeral: true });
  const settings = await getSettings(instance.id);
  const { data: ticket } = await db.from('tickets').select('*').eq('thread_id', interaction.channel.id).maybeSingle();
  const support = Array.isArray(settings.support_role_ids) ? settings.support_role_ids : [];
  const allowed = ticket?.owner_id === interaction.user.id || interaction.memberPermissions?.has(PermissionFlagsBits.ManageThreads) || support.some((roleId) => interaction.member?.roles?.cache?.has(roleId));
  if (!allowed) return interaction.reply({ content: 'Apenas o autor ou suporte pode fechar.', ephemeral: true });
  await db.from('tickets').update({ status: 'closed', closed_at: new Date().toISOString() }).eq('thread_id', interaction.channel.id);
  await interaction.reply('Ticket fechado.');
  setTimeout(() => interaction.channel.setArchived(true).catch(() => null), 2500);
}

async function handle(interaction, instance) {
  if (instance.guild_id !== interaction.guildId) return;
  if (interaction.isChatInputCommand() && interaction.commandName === 'painel') {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return interaction.reply({ content: 'Voce precisa de Gerenciar Servidor.', ephemeral: true });
    const type = interaction.options.getString('tipo', true);
    const channel = interaction.options.getChannel('canal', true);
    const payload = await panel(instance.id, type);
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
    console.log(`Online: ${client.user.tag} / ${instance.guild_name}`);
    await sync(instance, client).catch((error) => setError(instance.id, error.message));
  });
  client.on(Events.GuildCreate, () => sync(instance, client).catch((error) => setError(instance.id, error.message)));
  client.on(Events.GuildMemberAdd, async (member) => {
    if (member.guild.id !== instance.guild_id) return;
    const settings = await getSettings(instance.id);
    if (settings.auto_role_id) await member.roles.add(settings.auto_role_id).catch(() => null);
    if (!settings.welcome_channel_id) return;
    const channel = await member.guild.channels.fetch(settings.welcome_channel_id).catch(() => null);
    if (!channel?.isTextBased?.()) return;
    const body = (settings.welcome_message || '').replaceAll('{user}', `<@${member.id}>`).replaceAll('{server}', member.guild.name).replaceAll('{memberCount}', String(member.guild.memberCount));
    await channel.send({ embeds: [embed(settings, settings.welcome_title, body)] }).catch(() => null);
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
  const { data, error } = await db.from('bot_instances').select('*').eq('enabled', true);
  if (error) throw error;
  const ids = new Set((data || []).map((item) => item.id));
  for (const instance of data || []) await start(instance);
  for (const id of running.keys()) if (!ids.has(id)) await stop(id);
}

console.log('Aurora Zero runner iniciado.');
await reconcile();
setInterval(() => reconcile().catch((error) => console.error(error)), 30000);
