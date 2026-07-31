const state = { me: null, guilds: [], instances: [], guild: null, instance: null, resources: { channels: [], roles: [] }, settings: null, products: [] };
const ids = [
  'brand_name', 'brand_color', 'auto_role_id', 'verified_role_id', 'remove_auto_role_after_verify',
  'welcome_channel_id', 'welcome_mode', 'welcome_color', 'welcome_title', 'welcome_message',
  'auth_channel_id', 'auth_mode', 'auth_color', 'auth_title',
  'auth_message', 'auth_button_label', 'ticket_channel_id', 'support_role_ids', 'ticket_mode', 'ticket_color', 'ticket_title',
  'ticket_message', 'ticket_button_label', 'sales_channel_id', 'sales_mode', 'sales_color', 'sales_title', 'sales_message',
  'button_emoji'
];
const $ = (id) => document.getElementById(id);

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  if (response.status === 401) location.href = '/auth/discord';
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || data.error || 'Erro inesperado');
  return data;
}

function msg(text, error = false) {
  $('notice').textContent = text || '';
  $('notice').className = `${text ? 'show' : ''} ${error ? 'error' : ''}`;
}

function opt(value, label) {
  const node = document.createElement('option');
  node.value = value || '';
  node.textContent = label || value || 'Nao definido';
  return node;
}

function fill(select, items, selected, empty) {
  select.innerHTML = '';
  if (!select.multiple) select.appendChild(opt('', empty || 'Nao definido'));
  const selectedSet = new Set(Array.isArray(selected) ? selected : [selected].filter(Boolean));
  items.forEach((item) => {
    const node = opt(item.id, item.name);
    node.selected = selectedSet.has(item.id);
    select.appendChild(node);
  });
}

function write(id, value) {
  const node = $(id);
  if (!node) return;
  if (node.type === 'checkbox') node.checked = Boolean(value);
  else if (node.type === 'color') node.value = /^#[0-9a-f]{6}$/i.test(value || '') ? value : '#5865f2';
  else if (id.endsWith('_mode')) node.value = value === 'simple' ? 'simple' : 'embed';
  else if (node.multiple) {
    const selected = new Set(value || []);
    [...node.options].forEach((item) => { item.selected = selected.has(item.value); });
  } else node.value = value || '';
}

function read(id) {
  const node = $(id);
  if (node.type === 'checkbox') return node.checked;
  if (node.multiple) return [...node.selectedOptions].map((item) => item.value).filter(Boolean);
  return node.value;
}

function header() {
  $('me').textContent = state.me ? `Discord: ${state.me.username}` : '';
  $('botName').textContent = state.instance?.bot_name || 'Sem bot';
  const invite = $('inviteBot');
  if (invite) {
    invite.href = state.instance?.invite_url || '#';
    invite.classList.toggle('disabled', !state.instance?.invite_url);
    invite.textContent = state.instance?.invite_url ? 'Adicionar bot ao servidor' : 'Salve um token valido para gerar o convite';
  }
  const warning = $('runtimeWarning');
  if (warning) {
    warning.textContent = state.instance?.runtime_warning || '';
    warning.classList.toggle('show', Boolean(state.instance?.runtime_warning));
  }
  $('enabled').checked = Boolean(state.instance?.enabled);
  const online = Boolean(state.instance?.enabled && state.instance?.last_seen_at && !state.instance?.last_error);
  $('botDot').className = online ? 'online' : '';
  $('botState').textContent = !state.instance
    ? 'Cole o token para criar'
    : online
      ? `Online ${new Date(state.instance.last_seen_at).toLocaleString('pt-BR')}`
      : state.instance.last_error || (state.instance.enabled ? 'Aguardando central 24h' : 'Desligado');
}

function instanceStatus(instance) {
  const online = Boolean(instance?.enabled && instance?.last_seen_at && !instance?.last_error);
  if (online) return { text: `Online ${new Date(instance.last_seen_at).toLocaleString('pt-BR')}`, className: 'online' };
  if (instance?.last_error) return { text: instance.last_error, className: 'error' };
  if (instance?.enabled) return { text: 'Aguardando central 24h', className: 'waiting' };
  return { text: 'Desligado', className: 'off' };
}

function mergeSavedInstance(instance) {
  if (!instance) return;
  const instanceIndex = state.instances.findIndex((item) => item.id === instance.id);
  if (instanceIndex >= 0) state.instances[instanceIndex] = instance;
  else state.instances.unshift(instance);

  if (state.instance?.id === instance.id) state.instance = instance;

  let guild = state.guilds.find((item) => item.id === instance.guild_id);
  if (!guild) {
    guild = {
      id: instance.guild_id,
      name: instance.guild_name || instance.bot_name || 'Servidor salvo',
      icon: null,
      savedOnly: true,
      instance
    };
    state.guilds.push(guild);
  } else {
    guild.instance = instance;
    guild.name = guild.name || instance.guild_name || instance.bot_name || 'Servidor salvo';
  }
  if (state.guild?.id === instance.guild_id) {
    state.guild = guild;
    state.guild.instance = instance;
  }
}

function renderGuilds() {
  $('guildSelect').innerHTML = '';
  state.guilds.forEach((guild) => $('guildSelect').appendChild(opt(guild.id, guild.savedOnly ? `${guild.name} (salvo)` : guild.name)));
  if (state.guild) $('guildSelect').value = state.guild.id;
}

function renderSavedBots() {
  const list = $('savedBots');
  if (!list) return;
  list.innerHTML = '';
  if (!state.instances.length) {
    const empty = document.createElement('div');
    empty.className = 'saved-bot-card';
    empty.innerHTML = '<div><strong>Nenhum bot salvo ainda</strong><small>Escolha um servidor na aba Bot, cole o token e clique em Salvar bot.</small></div>';
    list.appendChild(empty);
    return;
  }
  state.instances.forEach((instance) => {
    const status = instanceStatus(instance);
    const node = document.createElement('div');
    node.className = 'saved-bot-card';
    node.innerHTML = `
      <div>
        <strong></strong>
        <small></small>
        <span class="pill"></span>
      </div>
      <div class="saved-bot-actions">
        <button type="button" data-action="open">Abrir</button>
        <a class="invite-link disabled" href="#" target="_blank" rel="noreferrer">Adicionar</a>
      </div>
    `;
    node.querySelector('strong').textContent = instance.bot_name || 'Bot salvo';
    node.querySelector('small').textContent = instance.guild_name || `Servidor ${instance.guild_id}`;
    const pill = node.querySelector('.pill');
    pill.textContent = status.text;
    pill.classList.add(status.className);
    node.querySelector('[data-action="open"]').onclick = () => selectGuild(instance.guild_id).catch((error) => msg(error.message, true));
    const invite = node.querySelector('a');
    if (instance.invite_url) {
      invite.href = instance.invite_url;
      invite.classList.remove('disabled');
    }
    list.appendChild(node);
  });
}

function renderResources() {
  document.querySelectorAll('[data-kind="role"]').forEach((select) => fill(select, state.resources.roles || [], state.settings?.[select.id], select.multiple ? '' : 'Nenhum cargo'));
  document.querySelectorAll('[data-kind="channel"]').forEach((select) => fill(select, state.resources.channels || [], state.settings?.[select.id], 'Nenhum canal'));
}

function sampleVars() {
  const firstChannel = state.resources.channels?.[0];
  const autoRole = state.resources.roles?.find((role) => role.id === read('auto_role_id'));
  const verifiedRole = state.resources.roles?.find((role) => role.id === read('verified_role_id'));
  return {
    user: '@Scott',
    userMention: '@Scott',
    userId: '1234567890',
    username: 'Scott',
    server: state.guild?.name || 'Aurora Store',
    guild: state.guild?.name || 'Aurora Store',
    memberCount: '128',
    channel: firstChannel ? `#${firstChannel.name}` : '#geral',
    channelMention: firstChannel ? `#${firstChannel.name}` : '#geral',
    channelName: firstChannel?.name || 'geral',
    owner: '@Dono',
    autoRole: autoRole?.name || 'Visitante',
    autoRoleMention: autoRole ? `@${autoRole.name}` : '@Visitante',
    verifiedRole: verifiedRole?.name || 'Membro',
    verifiedRoleMention: verifiedRole ? `@${verifiedRole.name}` : '@Membro',
    supportRoles: 'Suporte',
    supportRoleMentions: '@Suporte',
    welcomeChannel: '#boas-vindas',
    authChannel: '#verificacao',
    ticketChannel: '#tickets',
    salesChannel: '#vendas',
    product: 'Produto Exemplo',
    price: 'R$ 19,90',
    productDescription: 'Descricao curta do produto.',
    ticket: '#ticket-scott',
    ticketId: '0001',
    emoji: read('button_emoji') || '✨',
    date: new Date().toLocaleDateString('pt-BR'),
    time: new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
  };
}

function renderTemplatePreview(template) {
  const vars = sampleVars();
  return String(template || '').replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key) => vars[key] ?? '');
}

function renderMessagePreview(prefix) {
  const box = $(`${prefix}_preview`);
  if (!box) return;
  const mode = read(`${prefix}_mode`) || 'embed';
  const color = read(`${prefix}_color`) || read('brand_color') || '#5865f2';
  const title = renderTemplatePreview(read(`${prefix}_title`));
  const body = renderTemplatePreview(read(`${prefix}_message`));
  box.innerHTML = '';
  box.className = `message-preview ${mode === 'simple' ? 'simple' : 'embed'}`;
  const label = document.createElement('small');
  label.textContent = mode === 'simple' ? 'Previa: mensagem simples' : 'Previa: embed';
  box.appendChild(label);
  if (mode === 'simple') {
    const content = document.createElement('div');
    content.className = 'preview-simple';
    content.textContent = `${title ? `${title}\n` : ''}${body}`.trim() || 'Sua mensagem aparecera aqui.';
    box.appendChild(content);
    return;
  }
  const embedBox = document.createElement('div');
  embedBox.className = 'preview-embed';
  embedBox.style.borderLeftColor = color;
  const embedTitle = document.createElement('strong');
  embedTitle.textContent = title || read('brand_name') || 'Aurora Store';
  const embedBody = document.createElement('p');
  embedBody.textContent = body || 'Sua mensagem aparecera aqui.';
  const footer = document.createElement('span');
  footer.textContent = read('brand_name') || 'Aurora Store';
  embedBox.append(embedTitle, embedBody, footer);
  box.appendChild(embedBox);
}

function renderPreviews() {
  ['welcome', 'auth', 'ticket', 'sales'].forEach(renderMessagePreview);
}

function renderSettings() {
  ids.forEach((id) => write(id, state.settings?.[id]));
  renderResources();
  renderPreviews();
}

function renderProducts() {
  $('products').innerHTML = '';
  if (!state.products.length) {
    const empty = document.createElement('div');
    empty.className = 'product';
    empty.innerHTML = '<div><strong>Nenhum produto</strong><small>Cadastre produtos para gerar botoes de vendas.</small></div>';
    $('products').appendChild(empty);
    return;
  }
  state.products.forEach((product) => {
    const node = document.createElement('div');
    node.className = 'product';
    node.innerHTML = '<div><strong></strong><small></small><p></p></div><button>Excluir</button>';
    node.querySelector('strong').textContent = product.name;
    node.querySelector('small').textContent = product.price;
    node.querySelector('p').textContent = product.description || '';
    node.querySelector('button').onclick = () => deleteProduct(product.id);
    $('products').appendChild(node);
  });
}

async function selectGuild(id) {
  let guild = state.guilds.find((item) => item.id === id) || null;
  if (!guild) {
    const instance = state.instances.find((item) => item.guild_id === id);
    if (instance) {
      guild = {
        id: instance.guild_id,
        name: instance.guild_name || instance.bot_name || 'Servidor salvo',
        icon: null,
        savedOnly: true,
        instance
      };
      state.guilds.push(guild);
      renderGuilds();
    }
  }
  state.guild = guild || state.guilds[0] || null;
  state.instance = state.guild?.instance || null;
  if (state.guild) $('guildSelect').value = state.guild.id;
  $('instanceName').value = state.instance?.bot_name || 'Aurora Sales';
  $('botToken').value = '';
  header();
  await loadResources();
  await loadSettings();
  msg(state.instance ? '' : 'Escolha esse servidor, cole o token do bot dele e clique em Salvar bot.');
}

async function loadGuilds() {
  const [guilds, instances] = await Promise.all([api('/api/guilds'), api('/api/instances')]);
  state.guilds = guilds;
  state.instances = instances;
  state.instances.forEach(mergeSavedInstance);
  renderGuilds();
  renderSavedBots();
  if (state.guilds.length) await selectGuild(state.guilds[0].id);
  else msg('Nenhum servidor com permissao de gerenciamento foi encontrado.', true);
}

async function loadInstances() {
  state.instances = await api('/api/instances');
  state.instances.forEach(mergeSavedInstance);
  renderGuilds();
  renderSavedBots();
  header();
}

async function refreshStatus() {
  try {
    await loadInstances();
  } catch (error) {
    console.warn('Falha ao atualizar status dos bots:', error.message);
  }
}

async function loadResources(force = false) {
  if (!state.instance) {
    state.resources = { channels: [], roles: [] };
  } else {
    state.resources = await api(
      force ? `/api/instances/${state.instance.id}/resources/sync` : `/api/instances/${state.instance.id}/resources`,
      force ? { method: 'POST', body: JSON.stringify({}) } : {}
    );
  }
  renderResources();
}

async function refreshResources() {
  if (!state.instance) return msg('Salve o bot antes de buscar cargos e canais.', true);
  $('reloadResources').textContent = 'Buscando...';
  try {
    await loadResources(true);
    const count = `${state.resources.roles?.length || 0} cargos e ${state.resources.channels?.length || 0} canais`;
    msg(`Cargos e canais atualizados: ${count}.`);
  } finally {
    $('reloadResources').textContent = 'Atualizar cargos e canais';
  }
}

async function loadSettings() {
  if (!state.instance) {
    state.settings = null;
    state.products = [];
  } else {
    const data = await api(`/api/instances/${state.instance.id}/settings`);
    state.settings = data.settings;
    state.products = data.products;
  }
  renderSettings();
  renderProducts();
}

async function saveInstance() {
  if (!state.guild) return;
  if (!state.instance && !$('botToken').value.trim()) return msg('Cole o token do bot antes de salvar.', true);
  const data = await api('/api/instances', {
    method: 'POST',
    body: JSON.stringify({ guildId: state.guild.id, guildName: state.guild.name, botName: $('instanceName').value, token: $('botToken').value })
  });
  state.instance = data;
  state.guild.instance = data;
  mergeSavedInstance(data);
  $('botToken').value = '';
  header();
  await loadSettings();
  await loadInstances();
  msg(data.last_error || 'Bot salvo e ativado. A central 24h deve iniciar essa instancia em poucos segundos.');
}

async function toggle() {
  if (!state.instance) {
    $('enabled').checked = false;
    return msg('Salve o bot antes de ativar.', true);
  }
  state.instance = await api(`/api/instances/${state.instance.id}/enabled`, { method: 'POST', body: JSON.stringify({ enabled: $('enabled').checked }) });
  state.guild.instance = state.instance;
  mergeSavedInstance(state.instance);
  header();
  renderSavedBots();
  msg(state.instance.enabled ? 'Bot ativado. A central 24h deve ligar em alguns segundos.' : 'Bot desligado.');
}

async function saveSettings() {
  if (!state.instance) return msg('Salve o bot antes de editar configuracoes.', true);
  $('saveState').textContent = 'Salvando...';
  const payload = Object.fromEntries(ids.map((id) => [id, read(id)]));
  state.settings = await api(`/api/instances/${state.instance.id}/settings`, { method: 'PUT', body: JSON.stringify(payload) });
  $('saveState').textContent = 'Salvo.';
  renderPreviews();
  msg('Configuracoes salvas.');
}

async function addProduct() {
  if (!state.instance) return msg('Salve o bot antes de cadastrar produtos.', true);
  const product = await api(`/api/instances/${state.instance.id}/products`, {
    method: 'POST',
    body: JSON.stringify({ name: $('productName').value, price: $('productPrice').value, image_url: $('productImage').value, description: $('productDescription').value })
  });
  state.products.unshift(product);
  ['productName', 'productPrice', 'productImage', 'productDescription'].forEach((id) => { $(id).value = ''; });
  renderProducts();
  msg('Produto cadastrado.');
}

async function deleteProduct(id) {
  await api(`/api/instances/${state.instance.id}/products/${id}`, { method: 'DELETE' });
  state.products = state.products.filter((product) => product.id !== id);
  renderProducts();
  msg('Produto removido.');
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function uploadEmoji() {
  if (!state.instance) return msg('Salve o bot antes de criar emoji.', true);
  const file = $('emojiFile').files[0];
  if (!file) return msg('Escolha uma imagem para o emoji.', true);
  if (file.size > 256 * 1024) return msg('Use uma imagem de ate 256 KB para evitar erro no Discord.', true);
  $('emojiState').textContent = 'Criando emoji...';
  const data = await api(`/api/instances/${state.instance.id}/emoji`, {
    method: 'POST',
    body: JSON.stringify({ name: $('emojiName').value || 'aurora', image: await readFileAsDataUrl(file) })
  });
  state.settings = data.settings;
  renderSettings();
  $('emojiState').textContent = `Emoji criado: ${data.emoji}`;
  msg('Emoji criado e salvo para os botoes.');
}

function bind() {
  document.querySelectorAll('nav button').forEach((button) => button.onclick = () => {
    document.querySelectorAll('nav button').forEach((item) => item.classList.remove('active'));
    document.querySelectorAll('.tab').forEach((item) => item.classList.remove('active'));
    button.classList.add('active');
    $(`tab-${button.dataset.tab}`).classList.add('active');
    $('crumb').textContent = button.textContent;
  });
  $('guildSelect').onchange = (event) => selectGuild(event.target.value).catch((error) => msg(error.message, true));
  $('saveInstance').onclick = () => saveInstance().catch((error) => msg(error.message, true));
  $('enabled').onchange = () => toggle().catch((error) => msg(error.message, true));
  $('reloadResources').onclick = () => refreshResources().catch((error) => msg(error.message, true));
  $('saveSettings').onclick = () => saveSettings().catch((error) => msg(error.message, true));
  $('addProduct').onclick = () => addProduct().catch((error) => msg(error.message, true));
  $('uploadEmoji').onclick = () => uploadEmoji().catch((error) => msg(error.message, true));
  ids.forEach((id) => {
    const node = $(id);
    if (!node) return;
    node.addEventListener('input', renderPreviews);
    node.addEventListener('change', renderPreviews);
  });
}

async function init() {
  bind();
  try {
    state.me = await api('/api/me');
    await loadGuilds();
    header();
    setInterval(refreshStatus, 10000);
  } catch (error) {
    msg(error.message, true);
  }
}

init();
