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
const fullIntentRetryInterval = Math.max(Number(env('FULL_INTENT_RETRY_MS')) || 60000, 15000);
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

async function logEvent(instance, settings, type, message, metadata = {}) {
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
    JSON.stringify(metadata)
  ]).catch(console.error);
  if (!settings?.log_channel_id) return;
  const client = running.get(instance.id)?.client;
  const channel = client ? await client.channels.fetch(settings.log_channel_id).catch(() => null) : null;
  if (!channel?.isTextBased?.()) return;
  await channel.send({
    embeds: [embed(settings, `Log: ${type}`, message || 'Evento registrado.', settings.brand_color)]
  }).catch(() => null);
}

function variationsOf(item) {
  return Array.isArray(item?.variations) ? item.variations : [];
}

function chosenPrice(item, variant = null) {
  return variant?.price || item?.price || '';
}

function paymentText(payment) {
  if (!payment) return 'Pagamento: combine os detalhes com o suporte neste ticket.';
  const lines = [];
  const providerNames = {
    aurora: 'Aurora Pay interno',
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

async function sync(instance, client, withMembersIntent = true) {
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
  if (withMembersIntent) await clearWarning(instance.id);
  await guild.commands.set(commands);
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
    description: settings.sales_message,
    context,
    components: rows
  });
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

async function chooseVariation(interaction, instance, productId) {
  const settings = await getSettings(instance.id);
  const item = await product(instance.id, productId);
  if (!item) return interaction.reply({ content: 'Produto nao encontrado.', ephemeral: true });
  const variations = variationsOf(item);
  if (!variations.length) return openTicket(interaction, instance, productId);
  const rows = [];
  variations.slice(0, 25).forEach((variant, index) => {
    const n = Math.floor(index / 5);
    rows[n] ||= new ActionRowBuilder();
    rows[n].addComponents(btn(`az:variant:${item.id}:${index}`, `${variant.name} - ${variant.price}`, ButtonStyle.Primary, settings.button_emoji));
  });
  return interaction.reply({
    content: `Escolha uma variacao de **${item.name}** para continuar a compra:`,
    components: rows,
    ephemeral: true
  });
}

async function openTicket(interaction, instance, productId = null, variantIndex = null) {
  const settings = await getSettings(instance.id);
  const parent = await interaction.guild.channels.fetch(settings.ticket_channel_id || interaction.channelId).catch(() => null);
  if (!parent?.isTextBased?.()) return interaction.reply({ content: 'Canal base de tickets nao configurado.', ephemeral: true });
  const item = productId ? await product(instance.id, productId) : null;
  const variant = item && variantIndex !== null ? variationsOf(item)[Number(variantIndex)] || null : null;
  if (item?.product_type === 'variation' && !variant) return chooseVariation(interaction, instance, productId);
  const payment = item ? await paymentSettings(instance.id) : null;
  const thread = await parent.threads.create({
    name: `${item ? 'compra' : 'ticket'}-${interaction.user.username}`.slice(0, 95),
    type: ChannelType.PrivateThread,
    invitable: false
  });
  await addTicketMembers(thread, interaction, settings);
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
  await thread.send({
    content: `${interaction.user} ${mentions}`.trim(),
    embeds: [embed(
      settings,
      renderTemplate(item ? 'Novo pedido de {user}' : 'Novo ticket de {user}', ticketContext),
      item
        ? renderTemplate(`ID do pedido: **${order?.id || 'gerando'}**\nProduto: **{product}**\n${variant ? 'Variacao: **{variation}**\n' : ''}Preco: **${chosenPrice(item, variant)}**\n{productDescription}${variant?.description ? '\n{variationDescription}' : ''}\n\n${paymentText(payment)}`, ticketContext)
        : renderTemplate('Ola {user}, descreva o atendimento. {supportRoleMentions}', ticketContext),
      settings.ticket_color
    )],
    components: item
      ? [row(btn('az:approve', 'Aprovar compra', ButtonStyle.Success, '✅'), btn('az:close', 'Fechar ticket', ButtonStyle.Danger, settings.button_emoji))]
      : [row(btn('az:close', 'Fechar ticket', ButtonStyle.Danger, settings.button_emoji))]
  });
  await logEvent(instance, settings, item ? 'cart_created' : 'ticket_opened', item ? `Carrinho criado: ${item.name} por ${interaction.user.tag}` : `Ticket aberto por ${interaction.user.tag}`, {
    actorId: interaction.user.id,
    targetId: item?.id ? String(item.id) : null,
    channelId: thread.id,
    product: item?.name,
    variant
  });
  return interaction.reply({ content: `Ticket criado: ${thread}`, ephemeral: true });
}

function isSupportOrManager(interaction, settings, ticket) {
  const support = Array.isArray(settings.support_role_ids) ? settings.support_role_ids : [];
  return ticket?.owner_id === interaction.user.id
    || interaction.memberPermissions?.has(PermissionFlagsBits.ManageThreads)
    || support.some((roleId) => interaction.member?.roles?.cache?.has(roleId));
}

async function approvePurchase(interaction, instance) {
  if (!interaction.channel?.isThread?.()) return interaction.reply({ content: 'Use dentro de um ticket de compra.', ephemeral: true });
  const settings = await getSettings(instance.id);
  const ticket = await one('select * from tickets where thread_id=$1 and bot_instance_id=$2', [interaction.channel.id, instance.id]);
  if (!ticket?.product_id) return interaction.reply({ content: 'Esse ticket nao possui produto vinculado.', ephemeral: true });
  if (!isSupportOrManager(interaction, settings, ticket)) return interaction.reply({ content: 'Apenas suporte ou gerencia pode aprovar.', ephemeral: true });
  if (ticket.purchase_status === 'approved') return interaction.reply({ content: 'Essa compra ja foi aprovada.', ephemeral: true });

  const item = await product(instance.id, ticket.product_id);
  const variant = ticket.product_variant || null;
  if (!item) return interaction.reply({ content: 'Produto nao encontrado.', ephemeral: true });

  let updatedProduct = item;
  if (item.stock !== null && item.stock !== undefined) {
    if (Number(item.stock) <= 0) return interaction.reply({ content: 'Estoque esgotado para esse produto.', ephemeral: true });
    updatedProduct = await one('update products set stock = greatest(stock - 1, 0) where id=$1 and bot_instance_id=$2 returning *', [item.id, instance.id]) || item;
  }

  await query("update tickets set purchase_status='approved', approved_at=now() where thread_id=$1", [ticket.thread_id]);
  if (ticket.payment_order_id) {
    await query("update payment_orders set status='approved', approved_at=now() where id=$1 and bot_instance_id=$2", [ticket.payment_order_id, instance.id]);
  }
  const buyer = await interaction.client.users.fetch(ticket.owner_id).catch(() => null);
  const deliveryContent = settings.delivery_mode === 'auto' ? (item.delivery_content || 'Entrega automatica configurada, mas esse produto nao possui conteudo salvo.') : '';
  const context = { interaction, settings, product: item, variant, deliveryContent };
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

  await logEvent(instance, settings, 'purchase_approved', `Compra aprovada: ${item.name} para <@${ticket.owner_id}>`, {
    actorId: interaction.user.id,
    targetId: ticket.owner_id,
    channelId: interaction.channel.id,
    product: item.name,
    variant,
    stock: updatedProduct.stock
  });

  const threshold = Number(settings.stock_warn_threshold ?? 3);
  if (updatedProduct.stock !== null && updatedProduct.stock !== undefined && Number(updatedProduct.stock) <= threshold) {
    await logEvent(instance, settings, Number(updatedProduct.stock) <= 0 ? 'stock_empty' : 'stock_low', `Estoque de ${item.name}: ${updatedProduct.stock}`, {
      targetId: String(item.id),
      product: item.name,
      stock: updatedProduct.stock
    });
  }

  await interaction.reply({ content: 'Compra aprovada. Entrega enviada no privado e avaliacao liberada.', ephemeral: true });
  await interaction.channel.send(`✅ Compra aprovada por ${interaction.user}. Entrega enviada para <@${ticket.owner_id}>.`).catch(() => null);
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

async function closeTicket(interaction, instance) {
  if (!interaction.channel?.isThread?.()) return interaction.reply({ content: 'Use dentro de um ticket.', ephemeral: true });
  const settings = await getSettings(instance.id);
  const ticket = await one('select * from tickets where thread_id=$1', [interaction.channel.id]);
  const support = Array.isArray(settings.support_role_ids) ? settings.support_role_ids : [];
  const allowed = ticket?.owner_id === interaction.user.id || interaction.memberPermissions?.has(PermissionFlagsBits.ManageThreads) || support.some((roleId) => interaction.member?.roles?.cache?.has(roleId));
  if (!allowed) return interaction.reply({ content: 'Apenas o autor ou suporte pode fechar.', ephemeral: true });
  await query("update tickets set status='closed', closed_at=now() where thread_id=$1", [interaction.channel.id]);
  await logEvent(instance, settings, 'ticket_closed', `Ticket fechado por ${interaction.user.tag}`, {
    actorId: interaction.user.id,
    channelId: interaction.channel.id
  });
  await interaction.reply('Ticket fechado.');
  setTimeout(() => interaction.channel.setArchived(true).catch(() => null), 2500);
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
    const payload = await panel(instance.id, type, { interaction, channel });
    if (type === 'sales' && !payload.components.length) return interaction.reply({ content: 'Cadastre produtos no site antes de publicar.', ephemeral: true });
    await channel.send(payload);
    return interaction.reply({ content: `Painel publicado em ${channel}.`, ephemeral: true });
  }
  if (!interaction.isButton() || !interaction.customId.startsWith('az:')) return;
  const [, action, value, extra] = interaction.customId.split(':');
  if (action === 'auth') {
    const settings = await getSettings(instance.id);
    if (!settings.verified_role_id) return interaction.reply({ content: 'Cargo verificado nao configurado.', ephemeral: true });
    await interaction.member.roles.add(settings.verified_role_id).catch(() => null);
    if (settings.remove_auto_role_after_verify && settings.auto_role_id) await interaction.member.roles.remove(settings.auto_role_id).catch(() => null);
    await logEvent(instance, settings, 'auth_verified', `${interaction.user.tag} verificou acesso`, {
      actorId: interaction.user.id,
      channelId: interaction.channelId
    });
    return interaction.reply({ content: 'Acesso liberado.', ephemeral: true });
  }
  if (action === 'ticket') return openTicket(interaction, instance);
  if (action === 'buy') return chooseVariation(interaction, instance, Number(value));
  if (action === 'variant') return openTicket(interaction, instance, Number(value), Number(extra));
  if (action === 'approve') return approvePurchase(interaction, instance);
  if (action === 'close') return closeTicket(interaction, instance);
}

async function start(instance) {
  if (running.has(instance.id)) return;

  const buildClient = (withMembersIntent = true) => {
    const intents = withMembersIntent
      ? [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages]
      : [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages];
    const client = new Client({ intents });

    client.once(Events.ClientReady, async () => {
      const mode = withMembersIntent ? 'com members intent' : 'modo basico sem members intent';
      console.log(`[${runnerName}] Online: ${client.user.tag} / ${instance.guild_name} (${mode})`);
      await sync(instance, client, withMembersIntent).catch((error) => setError(instance.id, error.message));
    });

    client.on(Events.Error, (error) => {
      console.error(`[${runnerName}] Discord client error (${instance.bot_name || instance.id}):`, error);
      setError(instance.id, error.message).catch(console.error);
    });
    client.on(Events.Warn, (warning) => console.warn(`[${runnerName}] Discord warning (${instance.bot_name || instance.id}):`, warning));
    client.on(Events.GuildCreate, () => sync(instance, client, withMembersIntent).catch((error) => setError(instance.id, error.message)));

    if (withMembersIntent) {
      client.on(Events.GuildMemberAdd, async (member) => {
        if (member.guild.id !== instance.guild_id) return;
        const settings = await getSettings(instance.id);
        await logEvent(instance, settings, 'member_join', `${member.user.tag} entrou no servidor`, {
          actorId: member.user.id
        });
        if (settings.auto_role_id) {
          await member.roles.add(settings.auto_role_id).catch((error) => {
            const message = `Falha ao aplicar cargo automatico: ${error.message}. Verifique se o bot tem Gerenciar Cargos e se o cargo do bot esta acima do cargo automatico.`;
            console.error(`[${runnerName}] ${message}`);
            setWarning(instance.id, message).catch(console.error);
          });
        }
        if (!settings.welcome_channel_id) return;
        const channel = await member.guild.channels.fetch(settings.welcome_channel_id).catch(() => null);
        if (!channel?.isTextBased?.()) return;
        await channel.send(messagePayload(settings, {
          mode: settings.welcome_mode,
          color: settings.welcome_color,
          title: settings.welcome_title,
          description: settings.welcome_message,
          context: { member, settings, channel }
        })).catch((error) => {
          const message = `Falha ao enviar boas-vindas: ${error.message}. Verifique permissoes no canal configurado.`;
          console.error(`[${runnerName}] ${message}`);
          setWarning(instance.id, message).catch(console.error);
        });
      });

      client.on(Events.GuildMemberRemove, async (member) => {
        if (member.guild.id !== instance.guild_id) return;
        const settings = await getSettings(instance.id);
        await logEvent(instance, settings, 'member_leave', `${member.user?.tag || member.id} saiu do servidor`, {
          actorId: member.id
        });
      });
    }

    client.on(Events.MessageDelete, async (message) => {
      if (message.guildId !== instance.guild_id) return;
      const settings = await getSettings(instance.id);
      await logEvent(instance, settings, 'message_deleted', `Mensagem apagada em <#${message.channelId}>${message.author ? ` por ${message.author.tag}` : ''}`, {
        actorId: message.author?.id,
        channelId: message.channelId,
        content: String(message.content || '').slice(0, 500)
      });
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
    running.set(instance.id, { client, withMembersIntent: true, nextFullRetryAt: null });
  } catch (error) {
    if (/disallowed intents/i.test(error.message || '')) {
      client.destroy();
      const warning = 'Auto role e boas-vindas ao entrar precisam do Server Members Intent ativado no Discord Developer Portal. O bot esta online em modo basico.';
      console.warn(`[${runnerName}] ${instance.bot_name || instance.guild_name} sem Server Members Intent. Iniciando em modo basico.`);
      await setWarning(instance.id, warning).catch(console.error);
      client = buildClient(false);
      try {
        await client.login(decrypt(instance.token_encrypted));
        running.set(instance.id, { client, withMembersIntent: false, nextFullRetryAt: Date.now() + fullIntentRetryInterval });
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
await reconcile();
setInterval(() => reconcile().catch((error) => console.error(error)), pollInterval);
