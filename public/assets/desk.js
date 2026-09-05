(function () {
'use strict';

/**
 * A configuração vem do servidor, não daqui.
 *
 * O /assets/config.js é servido pelo server.js a partir das
 * variáveis de ambiente. Assim mudar de projeto Supabase, ou
 * acrescentar uma marca, não obriga a publicar este ficheiro —
 * que tem 177 KB e não devia mudar por causa de um endereço.
 *
 * Os valores por omissão são a rede: se o config.js não chegar, o
 * painel continua a funcionar com o que sempre funcionou.
 */
var CFG = window.__DESK_CONFIG || {};

/**
 * As marcas que este call centre atende.
 *
 * Hoje só a Airportlink. Quando os outros dois sites existirem,
 * entram pela variável BRANDS do servidor e o painel desenha uma
 * aba para cada — sem tocar neste ficheiro.
 */
var BRANDS = CFG.brands || [{ key: 'airportlink', label: 'Airportlink', color: '#0F766E' }];

/**
 * A marca que o agente está a ver agora.
 *
 * Começa na primeira e é substituída pelo que o servidor disser.
 * Lia do localStorage, e com vários agentes isso quebra: dois no
 * mesmo computador partilhavam a escolha, e o mesmo agente em dois
 * sítios via coisas diferentes.
 */
var brandAtual = BRANDS[0].key;

var SUPABASE_URL = CFG.supabaseUrl || 'https://ujpagsccfiledbtfeyuq.supabase.co';
var SUPABASE_ANON_KEY = CFG.supabaseAnonKey || 'sb_publishable_1Oc8DziBDPMs0MAxhrGGxw_qhTPIYOZ';
var STORAGE_BUCKET = 'support-files';
var SIGNED_URL_SECONDS = 300;
var MAX_FILE_BYTES = 10 * 1024 * 1024;
var RENDER_URL = CFG.mainApiUrl || 'https://airportlink.onrender.com';

// storageKey próprio: todos os embeds do Wix correm em filesusr.com,
// logo partilham origem e localStorage. Sem isto, criar uma conta de
// cliente noutro separador substituía a sessão de admin — e o painel
// ficava aberto a enviar o token errado. Com uma chave separada, as
// duas sessões coexistem.
var client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
    storageKey: 'airportlink-admin-auth'
  }
});

var el = function (id) { return document.getElementById(id); };
var qsa = function (s) { return Array.prototype.slice.call(document.querySelectorAll(s)); };

// ============================================================
// AUTO-ALTURA
// ============================================================
function notifyParent(m) { try { window.parent.postMessage(m, '*'); } catch (e) {} }
var lastSent = 0;
function reportHeight() {
  var h = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
  if (Math.abs(h - lastSent) < 12) return;
  lastSent = h;
  notifyParent({ type: 'resize', height: h });
}
if (window.ResizeObserver) new ResizeObserver(reportHeight).observe(document.body);
// O load pode já ter disparado — este ficheiro corre com defer.
if (document.readyState === 'complete') reportHeight();
else window.addEventListener('load', reportHeight);
[300, 900, 2000].forEach(function (ms) { setTimeout(reportHeight, ms); });
notifyParent('ready');

function escapeHtml(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
/**
 * Sempre em 24 horas.
 *
 * O formato local dá AM/PM em vários países, e num painel de
 * operações "7:30" sem indicação é a diferença entre um voo da manhã
 * e um da noite.
 */
function formatTime(v) {
  var d = new Date(v);
  return isNaN(d.getTime()) ? '' : d.toLocaleString('en-GB', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false
  });
}
function money(currency, value) {
  var c = currency ? String(currency).toUpperCase() : 'EUR';
  var n = Number(value);
  return isNaN(n) ? (c + ' 0.00') : (c + ' ' + n.toFixed(2));
}
function bookingWhen(b) {
  var t = b.booking_time ? String(b.booking_time).slice(0, 5) : '';
  return t ? ((b.booking_date || 'N/A') + ' \u00b7 ' + t) : (b.booking_date || 'N/A');
}
function bookingRef(b) { return b.booking_id || b.booking_reference || String(b.id || '').slice(0, 8); }

var currentAdmin = null;

/**
 * O id e o nome de quem está autenticado.
 *
 * O currentAdmin guarda { user, contact } — não o utilizador
 * diretamente. Ler currentAdmin.id dava undefined, e todas as
 * comparações de "esta conversa é minha?" davam falso: com um só
 * administrador, o painel dizia que outra pessoa tinha pegado a
 * conversa.
 */
function adminId() {
  return (currentAdmin && currentAdmin.user && currentAdmin.user.id) || null;
}

function adminName() {
  var email = currentAdmin && currentAdmin.user && currentAdmin.user.email;
  return email ? email.split('@')[0] : 'Airportlink';
}
var bookingFilters = { bookingId:'', email:'', name:'', pickup:'', dropoff:'',
  dateFrom:'', dateTo:'', soldFrom:'', soldTo:'', status:'' };

/**
 * A vista com que o painel abre.
 *
 * Era 'today-travel' — quem sai hoje. Mas abrir e ver o que entrou
 * de novo é a pergunta mais frequente: as viagens de hoje já foram
 * tratadas de manhã, e as reservas novas ainda não viu ninguém.
 *
 * As outras vistas continuam a um clique.
 */
/**
 * As reservas abrem em "Travelling today".
 *
 * Abriam em "all" — centenas de linhas, ordenadas por data, com o
 * que interessa hoje algures a meio. A pergunta que se faz ao abrir
 * o separador é "quem viaja hoje", não "quantas reservas existem".
 *
 * O "Booked today" fica ao lado, que é a outra pergunta: o que
 * entrou desde manhã.
 */
var quickView = 'today-travel';
var allBookings = [], bookingPage = 1, bookingPerPage = 50;
var contacts = [], contactFilters = { search:'', searchId:'' }, contactPage = 1, contactPerPage = 50;
var selectedContactBookings = [], selectedContactChats = [];
var conversations = [], convFilters = { search:'', status:'', subject:'' };
var agents = [], agentFilters = { search: '', status: 'all' };
var partners = [], ptFilters = { search: '', status: 'all' };
var charges = [], unclaimed = [];
var PARTNER_BUCKET = 'partner-documents';
var activeConvId = null, renderedAdminMsgIds = new Set();
var adminChatsChannel = null, adminMessagesChannel = null, adminSelectedFile = null;

var bookingSelect = 'id, booking_id, booking_reference, pickup, dropoff, booking_date, booking_time, passengers, price, status, payment_status, currency, amount_total, receipt_url, payment_method_type, email, phone_number, phone_code, notes, flight_number, full_name, created_at, user_id, booked_by, agent_commission_pct, agent_gross_price, passenger_name, passenger_email, passenger_phone, stripe_payment_intent_id, refunded_amount, refunded_at, refund_reason, driver_email_hold, driver_email_hold_reason, driver_details_sent_at, manual_driver_name, manual_driver_phone, manual_vehicle, manual_vehicle_plate, payment_mode, charge_at, charged_at, charge_attempts, last_charge_error, pickup_airport, pickup_city, preferred_languages, driver_payout, assigned_partner_id, assigned_at, released_count'
var activeBooking = null;

// ============================================================
// GATE
// ============================================================
function showGateError(t) { el('gateError').textContent = t; el('gateError').style.display = 'block'; reportHeight(); }

async function verifyAdmin() {
  var s = await client.auth.getSession();
  if (!s.data || !s.data.session) return null;
  var u = await client.auth.getUser();
  if (u.error || !u.data || !u.data.user) return null;

  // Conveniência de interface. A garantia real é a RLS no servidor.
  var c = await client.from('contacts').select('id, email, full_name, is_admin')
    .eq('id', u.data.user.id).maybeSingle();
  if (c.error) { console.error('admin check error:', c.error); return null; }
  if (!c.data || c.data.is_admin !== true) return null;
  return { user: u.data.user, contact: c.data };
}

async function enterAdmin(session) {
  currentAdmin = session;
  el('gateView').classList.add('hidden');
  el('bootView').classList.add('hidden');
  el('adminApp').classList.remove('hidden');
  el('adminWhoami').textContent = session.user.email;

  /**
   * O painel aparece já; os dados chegam a seguir.
   *
   * O await aqui segurava o ecrã até TODAS as chamadas terminarem.
   * Cada uma custa cerca de dois segundos, e o agente ficava a olhar
   * para nada durante esse tempo.
   *
   * As secções sabem mostrar "Loading..." sozinhas — é para isso que
   * lá está.
   */
  reportHeight();

  init().catch(function (e) {
    console.error('init:', e);
  });
}

el('gateBtn').addEventListener('click', async function () {
  var email = el('gateEmail').value.trim(), password = el('gatePassword').value;
  el('gateError').style.display = 'none';
  if (!email || !password) return showGateError('Please fill in both fields.');

  el('gateBtn').disabled = true;
  el('gateBtn').textContent = 'Signing in...';
  try {
    var res = await client.auth.signInWithPassword({ email: email, password: password });
    if (res.error) return showGateError(res.error.message || 'Sign in failed.');
    var session = await verifyAdmin();
    if (!session) {
      await client.auth.signOut();
      return showGateError('This account does not have administrator access.');
    }
    await enterAdmin(session);
  } catch (e) {
    console.error(e);
    showGateError('Something went wrong. Please try again.');
  } finally {
    el('gateBtn').disabled = false;
    el('gateBtn').textContent = 'Sign in';
  }
});
el('gatePassword').addEventListener('keydown', function (e) { if (e.key === 'Enter') el('gateBtn').click(); });
el('adminLogoutBtn').addEventListener('click', async function () {
  if (!await perguntar('Sign out?', 'Sign out of the admin panel?')) return;
  await client.auth.signOut();
  window.location.reload();
});

// ============================================================
// ANEXOS
// O caminho começa pelo ID DA CONVERSA, não pelo uuid de quem envia.
// Antes o admin gravava em 'uuid-do-admin/...' e o cliente não tinha
// permissão para ler — via o link e recebia "Could not open".
// ============================================================
function showConvNote(text, isError) {
  var note = el('convNote');
  if (!text) { note.classList.add('hidden'); return; }
  note.textContent = text;
  note.classList.remove('hidden');
  note.classList.toggle('error', !!isError);
  reportHeight();
}

async function openAttachment(att) {
  var path = att.file_path;
  if (!path && att.file_url) {
    var marker = '/' + STORAGE_BUCKET + '/';
    if (att.file_url.indexOf(marker) !== -1) path = att.file_url.split(marker)[1].split('?')[0];
  }
  if (!path) return avisar('Heads up', 'This attachment has no stored path.');

  path = decodeURIComponent(path);
  var res = await client.storage.from(STORAGE_BUCKET).createSignedUrl(path, SIGNED_URL_SECONDS);
  if (res.error || !res.data) {
    console.error('signed url error:', res.error, '| path:', path);
    return avisar('Heads up', 'Could not open the attachment.\n\nPath: ' + path +
      '\nError: ' + ((res.error && res.error.message) || 'unknown'));
  }
  window.open(res.data.signedUrl, '_blank', 'noopener');
}

function attachmentButton(att) {
  var btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'conv-attachment';
  btn.textContent = '\uD83D\uDCCE ' + att.file_name;
  btn.addEventListener('click', function () { openAttachment(att); });
  return btn;
}

/** Cola os anexos na bolha. O evento realtime chega antes de o
 *  upload terminar, por isso a bolha nasce sem anexo. */
async function refreshAttachments(messageId) {
  var bubble = document.querySelector('[data-msg-id="' + messageId + '"]');
  if (!bubble) return;

  var att = await client.from('support_attachments')
    .select('file_url, file_name, file_path').eq('message_id', messageId);

  if (att.error) { console.error('attachments select error:', att.error); return; }
  if (!att.data || !att.data.length) return;
  if (bubble.querySelectorAll('.conv-attachment').length >= att.data.length) return;

  Array.prototype.forEach.call(bubble.querySelectorAll('.conv-attachment'), function (n) { n.remove(); });
  att.data.forEach(function (a) { bubble.appendChild(attachmentButton(a)); });
  reportHeight();
}

// ============================================================
// SELEÇÃO DE FICHEIRO — com remoção
// ============================================================
function setAdminFile(file) {
  adminSelectedFile = file || null;
  if (adminSelectedFile) {
    el('adminFileChipName').textContent = adminSelectedFile.name;
    el('adminFileChip').classList.add('show');
  } else {
    el('adminFileInput').value = '';
    el('adminFileChip').classList.remove('show');
    el('adminFileChipName').textContent = '';
  }
  reportHeight();
}

el('adminAttachFileBtn').addEventListener('click', function () {
  if (el('adminAttachFileBtn').disabled) return;
  el('adminFileInput').click();
});

el('adminFileInput').addEventListener('change', function (e) {
  var f = e.target.files && e.target.files[0];
  if (!f) return;
  if (f.size > MAX_FILE_BYTES) {
    avisar('Heads up', 'That file is too large. The limit is 10 MB.');
    setAdminFile(null);
    return;
  }
  setAdminFile(f);
  showConvNote('');
});

// Sem isto, um upload falhado deixava o ficheiro preso e o chat
// encravado, sem forma de o remover.
el('adminFileChipRemove').addEventListener('click', function () {
  setAdminFile(null);
  showConvNote('');
});

// ============================================================
// BOOKINGS
// ============================================================
async function loadBookings(filters) {
  filters = filters || {};
  var tbody = el('bookingsList');
  tbody.innerHTML = '<tr><td colspan="9" class="loading-row">Loading...</td></tr>';

  /**
   * As mais recentes primeiro — pela data em que foram FEITAS.
   *
   * Ordenava por booking_date, que é o dia da viagem. Uma reserva
   * feita hoje para daqui a três meses aparecia no topo, e uma
   * feita há cinco minutos para amanhã ficava enterrada. Quem abre
   * o painel quer ver o que entrou agora.
   *
   * A ordenação por data de viagem continua a existir nas vistas
   * rápidas — "travelling today" ordena por essa, e faz sentido.
   */
  var ordem = filters.orderBy === 'travel' ? 'booking_date' : 'created_at';
  var q = client.from('bookings').select(bookingSelect)
    .order(ordem, { ascending: false });
  if (filters.bookingId) q = q.ilike('booking_id', '%' + filters.bookingId + '%');
  if (filters.email) q = q.ilike('email', '%' + filters.email + '%');
  if (filters.name) q = q.ilike('full_name', '%' + filters.name + '%');
  if (filters.pickup) q = q.ilike('pickup', '%' + filters.pickup + '%');
  if (filters.dropoff) q = q.ilike('dropoff', '%' + filters.dropoff + '%');
  // booking_date é o dia da viagem; created_at é o dia da compra.
  if (filters.dateFrom) q = q.gte('booking_date', filters.dateFrom);
  if (filters.dateTo) q = q.lte('booking_date', filters.dateTo);
  // created_at tem hora, por isso o "até" tem de ir ao fim do dia.
  if (filters.soldFrom) q = q.gte('created_at', filters.soldFrom + 'T00:00:00');
  if (filters.soldTo) q = q.lte('created_at', filters.soldTo + 'T23:59:59');
  if (filters.status) q = q.eq('status', filters.status);

  var res = await q;
  if (res.error) {
    tbody.innerHTML = '<tr><td colspan="9" class="error-row">' + escapeHtml(res.error.message) + '</td></tr>';
    return;
  }

  allBookings = res.data || [];
  bookingPage = 1;
  renderBookings(); renderBookingPagination(); renderBookingStats();
}

function renderBookingStats() {
  var today = new Date().toISOString().split('T')[0];
  var live = allBookings.filter(function (b) { return b.status !== 'cancelled'; });
  el('upcomingBookings').textContent = live.filter(function (b) { return b.booking_date >= today; }).length;
  el('revenueValue').textContent = live.reduce(function (s, b) { return s + (parseFloat(b.price) || 0); }, 0).toFixed(2);
  el('cancelledBookings').textContent = allBookings.filter(function (b) { return b.status === 'cancelled'; }).length;
  el('totalBookings').textContent = allBookings.length;
}

var QUICK_VIEWS = {
  'today-travel': {
    label: 'travelling today',
    test: function (b, today) { return b.booking_date === today && b.status !== 'cancelled'; },
    // Por hora de recolha: quem vai primeiro está primeiro.
    sort: function (a, b) { return String(a.booking_time || '').localeCompare(String(b.booking_time || '')); }
  },
  'tomorrow-travel': {
    label: 'travelling tomorrow',
    test: function (b, today, tomorrow) { return b.booking_date === tomorrow && b.status !== 'cancelled'; },
    sort: function (a, b) { return String(a.booking_time || '').localeCompare(String(b.booking_time || '')); }
  },
  'today-sold': {
    label: 'booked today',
    test: function (b, today) { return String(b.created_at || '').slice(0, 10) === today; },
    // Pela hora da compra, a mais recente primeiro: é a que ainda
    // não viste.
    sort: function (a, b) { return String(b.created_at || '').localeCompare(String(a.created_at || '')); }
  },
  unassigned: {
    label: 'with no partner',
    test: function (b, today) {
      return !b.assigned_partner_id && b.status !== 'cancelled' && b.booking_date >= today;
    },
    sort: function (a, b) { return String(a.booking_date || '').localeCompare(String(b.booking_date || '')); }
  },
  refunds: {
    label: 'needing a refund decision',
    // Canceladas e pagas, sem reembolso registado. É dinheiro do
    // cliente ainda contigo.
    test: function (b) {
      const paid = b.charged_at || b.payment_status === 'paid' || b.status === 'paid';
      const refunded = Number(b.refunded_amount || 0) > 0;
      return b.status === 'cancelled' && paid && !refunded;
    },
    sort: function (a, b) { return String(b.updated_at || '').localeCompare(String(a.updated_at || '')); }
  },
  all: {
    label: 'in total',
    test: function () { return true; },
    sort: function (a, b) { return String(b.created_at || '').localeCompare(String(a.created_at || '')); }
  }
};

function todayISO(offset) {
  var d = new Date();
  d.setDate(d.getDate() + (offset || 0));
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') +
    '-' + String(d.getDate()).padStart(2, '0');
}

function viewBookings(name) {
  var view = QUICK_VIEWS[name] || QUICK_VIEWS.all;
  var today = todayISO(0);
  var tomorrow = todayISO(1);

  return allBookings
    .filter(function (b) { return view.test(b, today, tomorrow); })
    .sort(view.sort);
}

function paintQuickViews() {
  var counts = {
    'today-travel': viewBookings('today-travel').length,
    'tomorrow-travel': viewBookings('tomorrow-travel').length,
    'today-sold': viewBookings('today-sold').length,
    unassigned: viewBookings('unassigned').length,
    refunds: viewBookings('refunds').length,
    all: allBookings.length
  };

  el('qvTravel').textContent = counts['today-travel'];
  el('qvTomorrow').textContent = counts['tomorrow-travel'];
  el('qvSold').textContent = counts['today-sold'];
  el('qvUnassigned').textContent = counts.unassigned;
  el('qvRefunds').textContent = counts.refunds;
  el('qvAll').textContent = counts.all;

  // Cor só onde significa alguma coisa a fazer.
  document.querySelector('[data-view="unassigned"]')
    .classList.toggle('urgent', counts.unassigned > 0);
  document.querySelector('[data-view="refunds"]')
    .classList.toggle('bad', counts.refunds > 0);
}

qsa('.qv').forEach(function (b) {
  b.addEventListener('click', function () {
    qsa('.qv').forEach(function (x) { x.classList.remove('active'); });
    b.classList.add('active');
    quickView = b.getAttribute('data-view');
    bookingPage = 1;
    renderBookings();
  });
});

function renderBookings() {
  var tbody = el('bookingsList');
  var rows = viewBookings(quickView);
  var start = (bookingPage - 1) * bookingPerPage;
  var page = rows.slice(start, start + bookingPerPage);

  paintQuickViews();
  paintTabAlerts();

  if (!page.length) {
    tbody.innerHTML = '<tr><td colspan="9"><div class="no-results">Nothing ' +
      escapeHtml((QUICK_VIEWS[quickView] || QUICK_VIEWS.all).label) + '.</div></td></tr>';
    return;
  }

  tbody.innerHTML = page.map(function (b) {
    return '<tr>' +
      '<td><strong>' + escapeHtml(bookingRef(b)) + '</strong></td>' +
      '<td><strong>' + escapeHtml(b.full_name || 'N/A') + '</strong><br><small style="color:var(--muted)">' + escapeHtml(b.email || '') + '</small></td>' +
      '<td style="max-width:260px">' + escapeHtml(b.pickup || 'N/A') + '<br><small style="color:var(--muted)">to ' + escapeHtml(b.dropoff || 'N/A') + '</small></td>' +
      '<td>' + escapeHtml(bookingWhen(b)) + '</td>' +
      '<td>' + escapeHtml(b.flight_number || '-') + '</td>' +
      '<td>' + (b.booked_by
        ? '<span class="status completed">agent</span>'
        : '<span style="color:var(--muted)">direct</span>') + '</td>' +
      '<td>' + escapeHtml(money(b.currency, b.price)) +
        (b.agent_gross_price ? '<br><small style="color:var(--muted)">public ' +
          escapeHtml(money(b.currency, b.agent_gross_price)) + '</small>' : '') + '</td>' +
      '<td><span class="status ' + escapeHtml(b.status || 'pending') + '">' + escapeHtml(b.status || 'pending') + '</span></td>' +
      '<td><button class="btn btn-small" data-view-booking="' + escapeHtml(b.id) + '">View</button></td></tr>';
  }).join('');

  qsa('[data-view-booking]').forEach(function (btn) {
    btn.addEventListener('click', function () { openDetails(btn.getAttribute('data-view-booking')); });
  });
  reportHeight();
}

function renderBookingPagination() {
  var p = el('bookingsPagination');
  // Conta as linhas da VISTA, não todas: com 'travelling today'
  // escolhido, paginar sobre o total dava páginas vazias.
  var totalPages = Math.ceil(viewBookings(quickView).length / bookingPerPage);
  if (totalPages <= 1) { p.innerHTML = ''; return; }

  var html = '<button class="pagination-btn" id="bookingPrevBtn">Prev</button>';
  for (var i = 1; i <= totalPages; i++) {
    if (i === bookingPage) html += '<button class="pagination-btn active">' + i + '</button>';
    else if (i === 1 || i === totalPages || (i >= bookingPage - 2 && i <= bookingPage + 2))
      html += '<button class="pagination-btn booking-page-btn" data-page="' + i + '">' + i + '</button>';
  }
  html += '<button class="pagination-btn" id="bookingNextBtn">Next</button>' +
          '<span class="pagination-info">Page ' + bookingPage + ' of ' + totalPages + '</span>';
  p.innerHTML = html;

  el('bookingPrevBtn').addEventListener('click', function () { changeBookingPage(bookingPage - 1); });
  el('bookingNextBtn').addEventListener('click', function () { changeBookingPage(bookingPage + 1); });
  qsa('.booking-page-btn').forEach(function (b) {
    b.addEventListener('click', function () { changeBookingPage(Number(b.getAttribute('data-page'))); });
  });
}

function changeBookingPage(page) {
  // Conta as linhas da VISTA, não todas: com 'travelling today'
  // escolhido, paginar sobre o total dava páginas vazias.
  var totalPages = Math.ceil(viewBookings(quickView).length / bookingPerPage);
  if (page < 1 || page > totalPages) return;
  bookingPage = page;
  renderBookings(); renderBookingPagination();
}

// O Stripe trabalha em unidades menores. O iene não tem cêntimos.
function majorFromMinor(amount, currency) {
  if (amount === null || amount === undefined) return null;
  return String(currency || 'EUR').toUpperCase() === 'JPY'
    ? Number(amount)
    : Number(amount) / 100;
}

function renderRefundBox(b) {
  var box = el('refundBox');
  el('refundError').style.display = 'none';
  el('refundOk').style.display = 'none';
  el('refundAmount').value = '';
  el('refundReason').value = '';
  el('refundCancel').checked = b.status !== 'cancelled';

  if (!b.stripe_payment_intent_id) {
    box.classList.add('hidden');
    return;
  }
  box.classList.remove('hidden');

  var cur = b.currency || 'EUR';
  var paid = b.amount_total ? majorFromMinor(b.amount_total, cur) : Number(b.price || 0);
  var done = Number(b.refunded_amount || 0);
  var left = Math.max(0, Number((paid - done).toFixed(2)));

  el('refundPaid').textContent = money(cur, paid);
  el('refundDone').textContent = money(cur, done);
  el('refundLeft').textContent = money(cur, left);
  el('refundAmount').max = left;
  el('refundAmount').placeholder = 'Full amount (' + left.toFixed(2) + ')';
  el('refundBtn').disabled = left <= 0;
  el('refundBtn').textContent = left <= 0 ? 'Fully refunded' : 'Issue refund';
}

el('refundBtn').addEventListener('click', async function () {
  if (!activeBooking) return;

  el('refundError').style.display = 'none';
  el('refundOk').style.display = 'none';

  var amount = el('refundAmount').value.trim();
  var reason = el('refundReason').value.trim();
  var cancel = el('refundCancel').checked;
  var cur = activeBooking.currency || 'EUR';
  var label = amount ? (money(cur, Number(amount))) : 'the full outstanding amount';

  if (!await perguntar('Issue refund',
      'Refund ' + label + ' to ' + (activeBooking.email || 'this customer') +
      '?\n\nThe money leaves your Stripe balance immediately and this cannot be undone here.')) {
    return;
  }

  el('refundBtn').disabled = true;
  el('refundBtn').textContent = 'Refunding...';

  try {
    var res = await fetch(RENDER_URL + '/api/admin/refund', {
      method: 'POST',
      headers: await authHeaders(),
      body: JSON.stringify({
        booking_id: activeBooking.id,
        amount: amount || undefined,
        cancel_booking: cancel,
        reason: reason || undefined
      })
    });

    var result = await res.json();
    if (!res.ok || result.error) throw new Error(result.error || ('HTTP ' + res.status));

    el('refundOk').textContent = 'Refunded ' + money(result.currency, result.refunded_now) +
      '. Total refunded on this booking: ' + money(result.currency, result.refunded_total) +
      (result.fully_refunded ? ' (fully refunded).' : '. Remaining: ' + money(result.currency, result.remaining) + '.');
    el('refundOk').style.display = 'block';

    await loadBookings(bookingFilters);
    activeBooking = allBookings.find(function (x) { return String(x.id) === String(activeBooking.id); }) || activeBooking;
    renderRefundBox(activeBooking);
    el('detailStatus').textContent = activeBooking.status || 'pending';
    el('detailStatus').className = 'status ' + (activeBooking.status || 'pending');
    el('detailPaymentStatus').textContent = activeBooking.payment_status || 'N/A';
  } catch (e) {
    console.error('refund error:', e);
    el('refundError').textContent = e.message;
    el('refundError').style.display = 'block';
    el('refundBtn').disabled = false;
    el('refundBtn').textContent = 'Issue refund';
  } finally {
    reportHeight();
  }
});

function openDetails(id) {
  var b = allBookings.find(function (x) { return String(x.id) === String(id); });
  if (!b) return;
  activeBooking = b;
  el('detailBookingId').textContent = bookingRef(b);
  el('detailName').textContent = b.full_name || 'N/A';
  el('detailEmail').textContent = b.email || 'N/A';
  el('detailPhone').textContent = [b.phone_code, b.phone_number].filter(Boolean).join(' ') || 'N/A';
  el('detailPassengers').textContent = b.passengers || 'N/A';
  el('detailFlight').textContent = b.flight_number || 'N/A';
  el('detailBookedBy').textContent = b.booked_by
    ? ('Travel agent' + (b.agent_commission_pct ? ' (' + b.agent_commission_pct + '% rate)' : ''))
    : 'Direct customer';
  el('detailPassenger').textContent = b.booked_by
    ? [b.passenger_name || b.full_name, b.passenger_phone || b.phone_number, b.passenger_email]
        .filter(Boolean).join(' \u00b7 ')
    : 'Same as customer';
  el('detailPaymentStatus').textContent = b.payment_status || 'N/A';
  el('detailRefunded').textContent = Number(b.refunded_amount || 0) > 0
    ? (money(b.currency, b.refunded_amount) +
       (b.refund_reason ? ' \u00b7 ' + b.refund_reason : ''))
    : 'Nothing refunded';
  el('detailAmountTotal').textContent = b.amount_total ? money(b.currency, b.amount_total / 100) : 'N/A';
  el('detailPaymentMethodType').textContent = b.payment_method_type || 'N/A';
  el('detailReceiptUrl').innerHTML = b.receipt_url
    ? '<a class="receipt-link" href="' + escapeHtml(b.receipt_url) + '" target="_blank" rel="noopener">Open receipt</a>' : 'N/A';
  el('detailPickup').textContent = b.pickup || 'N/A';
  el('detailDropoff').textContent = b.dropoff || 'N/A';
  el('detailDate').textContent = bookingWhen(b);
  el('detailPrice').textContent = money(b.currency, b.price);
  el('detailStatus').textContent = b.status || 'pending';
  el('detailStatus').className = 'status ' + (b.status || 'pending');
  el('detailNotes').textContent = b.notes || 'No notes';
  renderRefundBox(b);
  renderDriverBox(b);
  el('detailsModal').classList.remove('hidden');
}

// ============================================================
// POSTO DE ATENDIMENTO
//
// Duas conversas por agente. O limite é imposto no Postgres, não
// aqui — mas a interface tem de o explicar antes de alguém bater
// contra ele.
// ============================================================
var desk = {
  chats: [], current: null, messages: [],
  // 'unknown' e não 'offline': ainda não perguntámos ao servidor.
  // Arrancar em offline fazia o painel piscar — dizia offline
  // durante dois segundos e só depois mostrava o estado real.
  capacity: {}, state: 'unknown', heartbeat: null, channel: null
};

/**
 * O que sabemos antes de falar com a rede.
 *
 * Corre imediatamente, sem esperar por nada. O nome vem do
 * localStorage e o estado fica em suspenso até o servidor
 * responder — mostrar "offline" enquanto não se sabe é pior do que
 * não mostrar nada, porque parece uma resposta e não é.
 */
(function pintarDeImediato() {
  // O nome vem do servidor. O painel arranca sem ele.

  /**
   * Com defer, o DOMContentLoaded já disparou.
   *
   * Este ficheiro é carregado com defer, o que significa que corre
   * DEPOIS de o documento estar pronto — e um listener registado
   * aqui nunca chega a ser chamado.
   *
   * Enquanto esteve dentro do HTML isto funcionava, porque o script
   * corria a meio do carregamento. Ao separar os ficheiros deixou
   * de funcionar, e o painel ficava preso em 'unknown' com os
   * botões de estado desativados.
   */
  var pintar = function () {
    if (deskDisplayName && el('deskNameText')) paintDisplayName();
    document.body.setAttribute('data-duty', 'unknown');
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', pintar);
  } else {
    pintar();
  }
})();

/**
 * O cronómetro de uma conversa.
 *
 * Conta desde que a conversa abriu — não desde que o agente a
 * pegou. É o tempo que o parceiro do outro lado está a viver, e é
 * esse que interessa medir.
 *
 * Quando a conversa fecha, o número congela no valor final em vez
 * de desaparecer: fica o registo de quanto demorou.
 */
var chatClock = { timer: null, inicio: null, fim: null };

function relogioTexto(ms) {
  var s = Math.max(0, Math.floor(ms / 1000));
  var h = Math.floor(s / 3600);
  var m = Math.floor((s % 3600) / 60);
  var seg = s % 60;

  // Passada a hora, os segundos deixam de importar e só ocupam
  // espaço. Antes disso são exatamente o que se quer ver.
  if (h > 0) return h + 'h ' + String(m).padStart(2, '0') + 'm';
  return m + ':' + String(seg).padStart(2, '0');
}

function pintarRelogio() {
  var caixa = el('chatClock');
  if (!caixa || !chatClock.inicio) return;

  var fim = chatClock.fim || Date.now();
  var decorrido = fim - chatClock.inicio;

  el('clockValue').textContent = relogioTexto(decorrido);
  pintarAvisoResposta();
  el('clockLabel').textContent = chatClock.fim ? 'closed after' : 'open';

  var min = decorrido / 60000;
  caixa.className = 'chat-clock' +
    (chatClock.fim ? ' done' : (min >= 20 ? ' bad' : (min >= 10 ? ' warn' : '')));
}

/**
 * Arranca o cronómetro para uma conversa.
 *
 * `fechadaEm` só vem preenchido em conversas já resolvidas — nesse
 * caso não há intervalo a correr, só um número a mostrar.
 */
function arrancarRelogio(abertaEm, fechadaEm) {
  pararRelogio();

  var inicio = abertaEm ? Date.parse(abertaEm) : NaN;
  var caixa = el('chatClock');

  if (!caixa) return;

  if (!inicio || isNaN(inicio)) {
    caixa.hidden = true;
    return;
  }

  chatClock.inicio = inicio;
  chatClock.fim = fechadaEm ? Date.parse(fechadaEm) : null;
  caixa.hidden = false;

  pintarRelogio();

  // Só corre enquanto está aberta. Uma conversa fechada mostra um
  // número fixo e não gasta um intervalo por cada separador aberto.
  if (!chatClock.fim) {
    chatClock.timer = setInterval(pintarRelogio, 1000);
  }
}

/**
 * O aviso de demora na conversa aberta.
 *
 * Corre com o cronómetro, de segundo a segundo. Os limiares são os
 * mesmos que o servidor usa — 3, 5 e 10 minutos — mas aqui servem
 * só para mostrar. Quem decide e escala é o support_tick, porque um
 * agente com o separador fechado não pode escapar à regra.
 */
var replyWarn = { desde: null, nivel: 0 };

function pintarAvisoResposta() {
  var caixa = el('replyWarn');
  if (!caixa) return;

  if (!replyWarn.desde) {
    caixa.hidden = true;
    return;
  }

  var min = (Date.now() - replyWarn.desde) / 60000;
  var nivel = min >= 10 ? 3 : (min >= 5 ? 2 : (min >= 3 ? 1 : 0));

  if (!nivel) {
    caixa.hidden = true;
    replyWarn.nivel = 0;
    return;
  }

  caixa.hidden = false;
  caixa.className = 'reply-warn w' + nivel;

  var m = Math.floor(min);
  el('replyWarnText').textContent =
    nivel === 3 ? 'Waiting ' + m + ' min — escalated to your supervisor'
  : nivel === 2 ? 'Waiting ' + m + ' min — answer now'
  : 'Waiting ' + m + ' min';

  // Um som por nível, uma só vez. Repetir a cada segundo seria
  // castigo, e a cada minuto já ninguém liga.
  if (nivel > replyWarn.nivel) {
    replyWarn.nivel = nivel;
    if (nivel >= 2) beep();
  }
}

/** A conversa passa a esperar resposta a partir de agora. */
function marcarEspera(desde) {
  replyWarn.desde = desde ? Date.parse(desde) : null;
  replyWarn.nivel = 0;
  pintarAvisoResposta();
}

// ============================================================
// HISTÓRICO DO PARCEIRO
//
// Responder a alguém sem saber o que já foi dito é a diferença
// entre "quem é este?" e "vejo que escreveu na semana passada
// sobre a fatura". Estava a faltar.
// ============================================================
var hist = { partner: null, lista: [] };

async function abrirHistorico(partnerId, nome) {
  hist.partner = partnerId;
  el('histWho').textContent = nome || 'Past conversations';
  el('histList').innerHTML = '<div class="snip-none">Loading...</div>';
  el('histRead').hidden = true;
  el('histPanel').hidden = false;

  try {
    var res = await deskFetch('/api/admin/partner/' +
      encodeURIComponent(partnerId) + '/history');
    hist.lista = res.history || [];
  } catch (e) {
    el('histList').innerHTML = '<div class="snip-none">' + escapeHtml(e.message) + '</div>';
    return;
  }

  el('histCount').textContent = hist.lista.length +
    (hist.lista.length === 1 ? ' conversation' : ' conversations');

  if (!hist.lista.length) {
    el('histList').innerHTML = '<div class="snip-none">Nothing before this one.</div>';
    return;
  }

  el('histList').innerHTML = hist.lista.map(function (h) {
    var tags = [];
    if (h.status === 'open') tags.push('<span class="tag new">open</span>');
    if (h.closed_reason === 'no_agent_available') {
      tags.push('<span class="tag late">closed with no agent</span>');
    }
    if (h.reopened_count > 0) {
      tags.push('<span class="tag">reopened ' + h.reopened_count + '&times;</span>');
    }
    if (h.first_response_minutes != null) {
      tags.push('<span class="tag">answered in ' + agoLabel(h.first_response_minutes) + '</span>');
    }

    return '<button class="hist-item" data-hist="' + escapeHtml(h.chat_id) + '" type="button">' +
      '<div class="hist-top">' +
      '<span class="hist-subj">' +
      escapeHtml(h.subject || h.ticket_number || 'No subject') + '</span>' +
      '<span class="hist-when">' + escapeHtml(dataCurta(h.created_at)) + '</span></div>' +
      '<p class="hist-snip">' + escapeHtml(h.last_message_text || 'No messages') + '</p>' +
      (tags.length ? '<div class="hist-tags">' + tags.join('') + '</div>' : '') +
      '</button>';
  }).join('');

  qsa('[data-hist]').forEach(function (b) {
    b.addEventListener('click', function () { lerConversa(b.getAttribute('data-hist')); });
  });
}

async function lerConversa(chatId) {
  el('histThread').innerHTML = '<div class="snip-none">Loading...</div>';
  el('histRead').hidden = false;

  try {
    var res = await deskFetch('/api/admin/chat/' + encodeURIComponent(chatId) + '/full');
    var msgs = res.messages || [];

    if (!msgs.length) {
      el('histThread').innerHTML = '<div class="snip-none">No messages.</div>';
      return;
    }

    // As notas internas aparecem aqui porque quem lê é um agente.
    // O parceiro nunca as vê — é por isso que este endpoint existe
    // separado do dele.
    // A mesma marcação da conversa ao vivo, para não haver dois
    // aspetos diferentes para a mesma coisa.
    el('histThread').innerHTML = msgs.map(function (m) {
      if (m.internal) {
        return '<div class="d-note' + (m.system ? ' sys' : '') + '">' +
          '<span class="who">' +
          escapeHtml(m.system ? 'System' : (m.sender_name || 'note')) +
          ' &middot; ' + escapeHtml(deskClock(m.created_at)) + '</span>' +
          escapeHtml(m.body || '') + '</div>';
      }

      return '<div class="d-row ' + (m.sender === 'admin' ? 'mine' : 'theirs') +
        ' turn last"><div><div class="d-bub">' +
        escapeHtml(m.body || '') + '</div>' +
        '<div class="d-meta">' + escapeHtml(deskClock(m.created_at)) +
        (m.sender === 'admin' && m.sender_name
          ? ' &middot; ' + escapeHtml(m.sender_name) : '') +
        '</div></div></div>';
    }).join('');
  } catch (e) {
    el('histThread').innerHTML = '<div class="snip-none">' + escapeHtml(e.message) + '</div>';
  }
}

// ============================================================
// RESPOSTAS RÁPIDAS
//
// Um agente escreve as mesmas cinco frases todos os dias. Escreve
// "/" na caixa e a lista aparece; continua a escrever e filtra.
//
// Partilhadas por toda a equipa de propósito: se cada um tiver as
// suas, a voz da empresa desfaz-se em cinco vozes.
// ============================================================
var snips = { todos: [], vistos: [], escolhido: 0 };

function fecharSnips() {
  el('snipBox').hidden = true;
  snips.vistos = [];
  snips.escolhido = 0;
}

function pintarSnips(termo) {
  var caixa = el('snipBox');
  var t = String(termo || '').toLowerCase();

  snips.vistos = snips.todos.filter(function (s2) {
    if (!t) return true;
    return s2.shortcut.toLowerCase().indexOf(t) === 0 ||
      s2.label.toLowerCase().indexOf(t) >= 0;
  }).slice(0, 8);

  if (!snips.vistos.length) {
    caixa.innerHTML = '<div class="snip-none">No quick reply matches that.</div>';
    caixa.hidden = false;
    return;
  }

  snips.escolhido = Math.min(snips.escolhido, snips.vistos.length - 1);

  caixa.innerHTML = snips.vistos.map(function (s2, i) {
    return '<button class="snip' + (i === snips.escolhido ? ' on' : '') +
      '" data-snip="' + i + '" type="button">' +
      '<div class="snip-top"><span class="snip-key">' + escapeHtml(s2.shortcut) + '</span>' +
      '<span class="snip-lab">' + escapeHtml(s2.label) + '</span></div>' +
      '<p class="snip-body">' + escapeHtml(s2.body) + '</p></button>';
  }).join('');

  caixa.hidden = false;

  qsa('[data-snip]').forEach(function (b) {
    b.addEventListener('click', function () {
      usarSnip(snips.vistos[Number(b.getAttribute('data-snip'))]);
    });
  });
}

/**
 * Cola a resposta e devolve o cursor à caixa.
 *
 * Substitui só o atalho que se escreveu, não a caixa inteira: quem
 * já tinha escrito meia frase antes não a perde.
 */
function usarSnip(s2) {
  if (!s2) return;

  var campo = el('chatReply');
  var texto = campo.value;
  var corte = texto.lastIndexOf('/');

  campo.value = (corte >= 0 ? texto.slice(0, corte) : texto) + s2.body;
  fecharSnips();
  campo.focus();
  campo.setSelectionRange(campo.value.length, campo.value.length);
}

function dataCurta(iso) {
  var d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
}

// ============================================================
// CAIXAS DE DIÁLOGO
//
// O prompt(), o confirm() e o alert() do browser não funcionam
// dentro de um iframe com sandbox — e é assim que este painel
// corre no Wix. O pior é que não falham com erro: devolvem null em
// silêncio, exatamente como se a pessoa tivesse carregado em
// cancelar.
//
// Era isso que fazia "escrevi o nome e não gravou".
// ============================================================
var ask = { resolver: null };

/**
 * Uma pergunta de sim ou não.
 * Devolve uma promessa que resolve para true ou false.
 */
function perguntar(titulo, texto, botao) {
  return abrirAsk({ titulo: titulo, texto: texto, botao: botao || 'OK' });
}

/**
 * Uma pergunta com campo de texto.
 * Devolve o que foi escrito, ou null se cancelar.
 */
function pedirTexto(titulo, texto, valor, botao) {
  return abrirAsk({
    titulo: titulo, texto: texto, botao: botao || 'Save',
    campo: true, valor: valor || ''
  });
}

/** Um aviso com um só botão. */
function avisar(titulo, texto) {
  return abrirAsk({ titulo: titulo, texto: texto, botao: 'OK', soOk: true });
}

function abrirAsk(o) {
  var campo = el('askInput');

  el('askTitle').textContent = o.titulo || 'Confirm';
  el('askText').textContent = o.texto || '';
  el('askYes').textContent = o.botao;
  el('askNo').hidden = Boolean(o.soOk);

  campo.hidden = !o.campo;
  campo.value = o.valor || '';

  el('askBack').hidden = false;

  if (o.campo) {
    setTimeout(function () { campo.focus(); campo.select(); }, 30);
  } else {
    setTimeout(function () { el('askYes').focus(); }, 30);
  }

  return new Promise(function (resolve) {
    ask.resolver = function (valor) {
      el('askBack').hidden = true;
      ask.resolver = null;
      resolve(valor);
    };
  });
}

el('askYes').addEventListener('click', function () {
  if (!ask.resolver) return;
  var campo = el('askInput');
  ask.resolver(campo.hidden ? true : campo.value.trim());
});

el('askNo').addEventListener('click', function () {
  if (ask.resolver) ask.resolver(el('askInput').hidden ? false : null);
});

el('askBack').addEventListener('click', function (e) {
  // Clicar fora cancela, como qualquer caixa de diálogo.
  if (e.target === el('askBack') && ask.resolver) {
    ask.resolver(el('askInput').hidden ? false : null);
  }
});

el('askInput').addEventListener('keydown', function (e) {
  if (e.key === 'Enter') { e.preventDefault(); el('askYes').click(); }
});

document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape' && !el('askBack').hidden) el('askNo').click();
});

function pararRelogio() {
  if (chatClock.timer) clearInterval(chatClock.timer);
  chatClock.timer = null;
}

function agoLabel(minutes) {
  var m = Math.round(Number(minutes) || 0);
  if (m < 1) return 'now';
  if (m < 60) return m + 'm';
  if (m < 1440) return Math.round(m / 60) + 'h';
  return Math.round(m / 1440) + 'd';
}

/**
 * O historial de quem deixou passar esta conversa.
 *
 * Fica visível a quem a atender, para não haver surpresas: se o
 * parceiro disser "já estou à espera há dez minutos", vê-se aqui
 * porquê.
 */
/**
 * Quem é a empresa e o que tem em aberto.
 *
 * Ao lado da conversa, não noutro separador: responder a "quando
 * recebo" ou "porque não tenho viagens" exigia sair da conversa,
 * procurar, e voltar — e o parceiro fica à espera todo esse tempo.
 */
async function renderChatCtx(chatId) {
  var box = el('chatCtx');
  box.innerHTML = '<div class="ctx-h">Loading</div>';

  try {
    var data = await deskFetch('/api/admin/chat/' + encodeURIComponent(chatId) + '/context');
    var c = data.context;

    if (!c) { box.innerHTML = '<div class="ctx-h">No details</div>'; return; }

    var money = function (v) { return 'EUR ' + Number(v || 0).toFixed(0); };
    var since = c.joined_at ? String(c.joined_at).slice(0, 10) : '—';

    var docsLine = c.docs_rejected
      ? '<span class="bad">' + c.docs_rejected + ' rejected</span>'
      : (c.docs_expired
          ? '<span class="bad">' + c.docs_expired + ' expired</span>'
          : '<span class="ok">' + c.docs_approved + ' approved</span>');

    box.innerHTML =
      '<div class="ctx-big"><div class="k">Owed to them</div>' +
      '<div class="v">' + escapeHtml(money(c.owed_eur)) + '</div></div>' +

      '<div class="ctx-h">Company</div>' +
      '<div class="ctx-row"><span>Status</span><span class="' +
        (c.status === 'approved' ? 'ok' : 'bad') + '">' + escapeHtml(c.status) + '</span></div>' +
      '<div class="ctx-row"><span>Country</span><span>' + escapeHtml(c.country || '—') + '</span></div>' +
      '<div class="ctx-row"><span>Partner since</span><span>' + escapeHtml(since) + '</span></div>' +
      '<div class="ctx-row"><span>Contact</span><span>' +
        escapeHtml(c.contact_name || '—') + '</span></div>' +
      // Clicável: copia o número em vez de obrigar a transcrevê-lo.
      '<div class="ctx-row"><span>Phone</span>' +
        (c.contact_phone
          ? '<button class="ctx-copy" data-copy="' + escapeHtml(c.contact_phone) + '">' +
            escapeHtml(c.contact_phone) + '</button>'
          : '<span>—</span>') + '</div>' +
      '<div class="ctx-row"><span>Email</span>' +
        '<button class="ctx-copy" data-copy="' + escapeHtml(c.email || '') + '">' +
        escapeHtml(c.email || '—') + '</button></div>' +

      '<div class="ctx-h">Setup</div>' +
      '<div class="ctx-row"><span>Documents</span>' + docsLine + '</div>' +
      '<div class="ctx-row"><span>Drivers</span><span class="' +
        (c.drivers ? '' : 'bad') + '">' + c.drivers + '</span></div>' +
      '<div class="ctx-row"><span>Vehicles</span><span class="' +
        (c.vehicles ? '' : 'bad') + '">' + c.vehicles + '</span></div>' +
      '<div class="ctx-row"><span>Airports</span><span>' +
        escapeHtml((c.operating_airports || []).join(', ') || '—') + '</span></div>' +
      '<div class="ctx-row"><span>Payout details</span><span class="' +
        (c.has_payout ? 'ok' : 'bad') + '">' + (c.has_payout ? 'on file' : 'missing') + '</span></div>' +

      '<div class="ctx-h">Rides</div>' +
      '<div class="ctx-row"><span>Completed</span><span>' + c.rides_total + '</span></div>' +
      '<div class="ctx-row"><span>Upcoming</span><span>' + c.rides_upcoming + '</span></div>' +
      '<div class="ctx-row"><span>Last ride</span><span>' +
        escapeHtml(c.last_ride_on || '—') + '</span></div>' +
      '<div class="ctx-row"><span>Released</span><span class="' +
        (Number(c.times_released) > 2 ? 'bad' : '') + '">' + (c.times_released || 0) + '</span></div>' +

      ((data.upcoming || []).length
        ? '<div class="ctx-h">Next up</div>' +
          data.upcoming.map(function (r) {
            return '<div class="ctx-ride"><b>' +
              escapeHtml(r.booking_reference || r.booking_id || '') + '</b>' +
              '<span>' + escapeHtml(r.booking_date) +
              (r.booking_time ? ' · ' + escapeHtml(String(r.booking_time).slice(0, 5)) : '') +
              '</span><span>' + escapeHtml(String(r.pickup || '').slice(0, 30)) + '</span></div>';
          }).join('')
        : '');

    qsa('#chatCtx [data-copy]').forEach(function (b) {
      b.addEventListener('click', function () {
        var original = b.textContent;
        navigator.clipboard.writeText(b.getAttribute('data-copy')).then(function () {
          b.textContent = 'Copied';
          setTimeout(function () { b.textContent = original; }, 1200);
        }).catch(function () {});
      });
    });
  } catch (e) {
    box.innerHTML = '<div class="ctx-h">Could not load</div>';
    console.error('chat context:', e.message);
  }
}

async function renderChatLog(chatId) {
  var box = el('chatLog');
  box.classList.add('hidden');

  try {
    var data = await deskFetch('/api/admin/chat-log');
    var mine = (data.log || []).filter(function (o) { return o.chat_id === chatId; });

    if (!mine.length) return;

    box.innerHTML = mine.slice(0, 6).map(function (o) {
      var label = {
        accepted: '<span class="took">answered</span>',
        missed: '<span class="miss">did not answer</span>',
        declined: '<span class="miss">passed</span>',
        cancelled: 'cancelled',
        ringing: 'ringing'
      }[o.outcome] || o.outcome;

      return '<b>' + escapeHtml(o.agent_name) + '</b> ' + label +
        (o.seconds_taken ? ' · ' + o.seconds_taken + 's' : '') +
        ' · ' + escapeHtml(formatTime(o.offered_at));
    }).join('<br>');

    box.classList.remove('hidden');
  } catch (e) {
    console.error('chat log:', e.message);
  }
}

async function deskFetch(path, body) {
  var res = await fetch(DRIVERS_URL + path, {
    method: body ? 'POST' : 'GET',
    headers: await authHeaders(),
    body: body ? JSON.stringify(body) : undefined
  });

  var text = await res.text();
  var data;

  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error('The drivers service returned an unexpected response (HTTP ' +
      res.status + '). It may be starting up.');
  }

  if (!res.ok || data.error) throw new Error(data.error || ('HTTP ' + res.status));
  return data;
}

/**
 * De onde vêm as conversas, conforme a aba.
 *
 * Os parceiros têm tabela própria; clientes e agências partilham a
 * support_chats, separados pela coluna audience. As três filas têm
 * a mesma forma, por isso o resto do painel não precisa de saber a
 * diferença.
 */
/**
 * As rotas mudam com a aba.
 *
 * Clientes e agências vivem noutra tabela, com funções próprias.
 * Devolver o caminho certo aqui evita um "if" espalhado por cada
 * sítio que pega, fecha ou larga uma conversa.
 */
function rotaDaAba(acao) {
  var apoio = audAtual === 'customers' || audAtual === 'agents';

  if (acao === 'claim') {
    return apoio ? '/api/admin/support/claim' : '/api/admin/chat/claim';
  }
  if (acao === 'close') {
    return apoio ? '/api/admin/support/close' : '/api/admin/chat/close';
  }
  // As mensagens vivem em tabelas diferentes, com nomes de coluna
  // diferentes. A rota de apoio traduz-as antes de as devolver.
  if (acao === 'messages') {
    return apoio ? '/api/admin/support-chat/' : '/api/admin/chat/';
  }
  if (acao === 'send') {
    return apoio ? '/api/admin/support/send' : '/api/admin/chat/send';
  }
  return '/api/admin/chat/release';
}

function filaDaAba() {
  if (audAtual === 'customers') {
    return { url: '/api/admin/support-queue?audience=customer', tipo: 'support' };
  }
  if (audAtual === 'agents') {
    return { url: '/api/admin/support-queue?audience=agency', tipo: 'support' };
  }
  return { url: '/api/admin/chats', tipo: 'partner' };
}

async function loadDesk() {
  var fila = filaDaAba();

  try {
    /**
     * A fila da aba ativa.
     *
     * A de clientes e a de agências trazem a capacidade dentro da
     * mesma resposta; a dos parceiros pede-a à parte, como sempre
     * pediu. Uma chamada a menos é dois segundos a menos.
     */
    var [queue, cap] = await Promise.all([
      deskFetch(fila.url),
      fila.tipo === 'support'
        ? Promise.resolve(null)
        : deskFetch('/api/admin/capacity')
    ]);

    if (fila.tipo === 'support') cap = queue.capacity || {};

    // A resposta traz as conversas de TODAS as marcas: as abas
    // precisam de contar as filas das outras para mostrar o aviso.
    // A que se desenha é só a da marca ativa.
    desk.todas = queue.chats || [];
    desk.chats = BRANDS.length > 1
      ? desk.todas.filter(function (c) { return marcaDe(c) === brandAtual; })
      : desk.todas;

    desk.capacity = cap || {};
    pintarMarcas();
    pintarAudTabs();
    renderDesk();

    // O último chat pode ter fechado do lado do parceiro, ou outro
    // agente pode ter ficado com um dos meus. O estado acompanha.
    ajustarActive();
    subscribeDesk();

    // Uma oferta a tocar neste agente. Vem no mesmo pedido para não
    // haver um segundo caminho por onde possa falhar.
    if (queue.ringing) {
      showRing(queue.ringing);
      return;
    }

    if (ring.offer) stopRing();

    // Ninguém a tocar, mas há quem espere e eu estou livre. Pede
    // para tocar: a oferta é criada quando a mensagem chega, e se
    // nessa altura ninguém estava em Live, ninguém a recebeu.
    var mineOpen = (desk.capacity.my_open_chats || 0);
    var waiting = (desk.capacity.waiting || 0);

    if (desk.state === 'live' && waiting > 0 && mineOpen < 2) {
      try {
        var asked = await deskFetch('/api/admin/chat/ring', {});
        if (asked && asked.ok) {
          // Voltar a carregar traz a oferta acabada de criar.
          var again = await deskFetch('/api/admin/chats');
          if (again.ringing) showRing(again.ringing);
        }
      } catch (e) {
        console.error('ring request:', e.message);
      }
    }
  } catch (e) {
    el('chatList').innerHTML = '<div class="no-results">' + escapeHtml(e.message) + '</div>';
  }
}

/**
 * Quem está do outro lado.
 *
 * Cada fila chama-lhe outra coisa: os parceiros têm trading_name,
 * os clientes e as agências vêm com who já resolvido pela vista.
 * Isto poupa um "if" em cada sítio que desenha um nome.
 */
function quemE(c) {
  return (c && (c.who || c.trading_name || c.legal_name || c.full_name ||
    c.email)) || 'Someone';
}

function renderDesk() {
  var cap = desk.capacity;
  var mine = cap.my_open_chats || 0;
  // Três, não dois. O número real está no claim_chat do Postgres —
  // aqui é só para mostrar, e quem decide é sempre o servidor.
  var limit = 3;

  el('capMine').textContent = mine + '/' + limit;
  el('capWaiting').textContent = cap.waiting || 0;
  el('capAgents').textContent = (cap.agents_live || 0) +
    (cap.agents_break ? ' +' + cap.agents_break : '');

  // O contador conta quem ESPERA, não quem está a ser atendido: é o
  // número que exige acção. Uma conversa já pegada não precisa de
  // fazer piscar nada.
  var waiting = desk.chats.filter(function (c) {
    return c.unread_for_admin > 0 && !c.assigned_to;
  }).length;

  var badge = el('chatBadge');
  badge.textContent = waiting || '';
  badge.className = waiting ? 'badge bad' : '';

  // Offline com gente à espera é o pior caso, e o que mais fácil
  // passa despercebido. A barra do topo pisca até se resolver.
  document.body.classList.toggle('has-waiting', waiting > 0);

  // A barra do topo, visível de qualquer separador.
  el('deskbarMine').textContent = mine + '/' + limit + ' chats';
  paintTabAlerts();

  var alert = el('deskAlert');

  if (waiting) {
    el('deskAlertText').textContent = waiting +
      (waiting === 1 ? ' partner waiting' : ' partners waiting');
    alert.classList.remove('hidden');
  } else {
    alert.classList.add('hidden');
  }

  if (!desk.chats.length) {
    el('chatList').innerHTML = '<div class="no-results">No conversations yet.</div>';
    return;
  }

  /**
   * Duas secções: as minhas em cima, o resto por baixo.
   *
   * Numa lista única, as minhas conversas ficavam misturadas entre
   * as dos outros e ordenadas por urgência — e a que eu tenho de
   * responder podia estar a meio. As minhas são as que exigem ação
   * minha; as outras são contexto.
   */
  /**
   * Na aba de escaladas, a lista é outra.
   *
   * Estas conversas não estão na fila normal — foram tiradas de lá
   * de propósito, para nenhum agente as voltar a pegar.
   */
  if (audAtual === 'escalated') {
    if (!escaladas.length) {
      el('chatList').innerHTML = '<div class="no-results">' +
        'Nothing escalated right now.<br><span style="color:var(--muted);' +
        'font-size:13px">When an agent cannot resolve something, it lands here.' +
        '</span></div>';
      return;
    }

    el('chatList').innerHTML = '<div class="list-head mine">Escalated <span>' +
      escaladas.length + '</span></div>' + escaladas.map(function (c) {
        return '<button class="chat-row urgent" data-chat="' + escapeHtml(c.chat_id) +
          '" type="button">' +
          '<div class="row-top"><strong>' +
          escapeHtml(quemE(c)) +
          '</strong><span class="when">' + (c.escalated_minutes || 0) + 'm</span></div>' +
          // A nota vem no formato "Escalated by Rick: o que se passa".
          // Separa-se aqui em vez de guardar o nome numa coluna
          // própria — seria mais um sítio para manter sincronizado.
          '<div class="snip">' + escapeHtml(semPrefixo(c.escalation_note)) + '</div>' +
          '<div class="tags"><span class="tag bad">from ' +
          escapeHtml(quemEscalou(c.escalation_note)) + '</span></div>' +
          '</button>';
      }).join('');

    qsa('[data-chat]').forEach(function (b) {
      b.addEventListener('click', function () {
        openDeskChat(b.getAttribute('data-chat'));
      });
    });

    return;
  }

  var visiveis = filtrarConversas(desk.chats);

  var minhas = visiveis.filter(function (c) {
    return c.assigned_to === adminId();
  });

  var outras = visiveis.filter(function (c) {
    return c.assigned_to !== adminId();
  });

  var cartao = function (c) {
    var isMine = c.assigned_to === (adminId());
    var taken = c.assigned_to && !isMine;

    var tags = [];
    if (c.urgent) tags.push('<span class="tag" style="background:var(--bad-bg);color:var(--bad);border-color:transparent">urgent</span>');
    if (c.unread_for_admin > 0) tags.push('<span class="tag new">' + c.unread_for_admin + ' new</span>');
    if (c.waiting_minutes >= 10) tags.push('<span class="tag wait">waiting ' + agoLabel(c.waiting_minutes) + '</span>');
    // A demora a responder é diferente de estar na fila: aqui já
    // alguém pegou e está a demorar.
    if (c.awaiting_reply_minutes >= 3) {
      tags.push('<span class="tag late">' + c.awaiting_reply_minutes + ' min unanswered</span>');
    }
    if (isMine) tags.push('<span class="tag mine">mine</span>');
    if (taken) {
      tags.push('<span class="tag busy">live &middot; ' +
        escapeHtml(c.assigned_agent_name || 'another agent') + '</span>');
    }

    return '<button class="chat-row' +
      (desk.current === c.chat_id ? ' active' : '') +
      (isMine ? ' mine' : '') + (c.urgent ? ' urgent' : '') +
      (c.awaiting_reply_minutes >= 5 ? ' late' : '') +
      '" data-chat="' + escapeHtml(c.chat_id) + '" type="button">' +
      '<div class="top"><span class="nm">' +
      escapeHtml(quemE(c)) + '</span>' +
      '<span class="ago">' + escapeHtml(agoLabel(c.minutes_since)) + '</span></div>' +
      '<div class="snip">' + escapeHtml(c.last_message_text || 'No messages yet') + '</div>' +
      (tags.length ? '<div class="tags">' + tags.join('') + '</div>' : '') +
      '</button>';
  };

  var html = '';

  if (minhas.length) {
    html += '<div class="list-head mine">Mine <span>' + minhas.length + '</span></div>' +
      minhas.map(cartao).join('');
  }

  if (outras.length) {
    html += '<div class="list-head">All conversations <span>' + outras.length +
      '</span></div>' + outras.map(cartao).join('');
  }

  /**
   * As que fechei, no fim.
   *
   * Não aparecem por omissão — só com o filtro em "closed". Uma
   * lista de trabalho não deve ter dentro o que já está feito, mas
   * também não devia ser preciso ir a outro lado para o encontrar.
   */
  if (vistaAtual === 'closed' && fechadas.length) {
    html += '<div class="list-head">Closed by me <span>' + fechadas.length +
      '</span></div>' + fechadas.map(function (c) {
        return '<button class="chat-row" data-closed="' + escapeHtml(c.chat_id) +
          '" type="button">' +
          '<div class="row-top"><strong>' +
          escapeHtml(quemE(c)) +
          '</strong><span class="when">' + escapeHtml(dataCurta(c.closed_at)) +
          '</span></div>' +
          '<div class="snip">' + escapeHtml(c.last_message_text || '') + '</div>' +
          '<div class="tags"><span class="tag">' +
          escapeHtml(String(c.closed_reason || 'closed').replace(/_/g, ' ')) +
          '</span></div></button>';
      }).join('');
  }

  // Com filtro ativo, uma lista vazia tem de dizer porquê. Sem
  // isto parecia que não havia conversas nenhumas.
  if (!html) {
    html = '<div class="no-results">Nothing matches that filter.' +
      '<br><button class="clear-btn" id="deskNoneClear" type="button" ' +
      'style="margin-top:12px">Clear the filter</button></div>';
  }

  el('chatList').innerHTML = html;

  var limpar = document.getElementById('deskNoneClear');
  if (limpar) {
    limpar.addEventListener('click', function () {
      el('deskSearch').value = '';
          renderDesk();
    });
  }

  // Uma conversa fechada abre em leitura, com o fio completo.
  qsa('[data-closed]').forEach(function (b) {
    b.addEventListener('click', function () {
      lerConversa(b.getAttribute('data-closed'));
      el('histPanel').hidden = false;
      el('histRead').hidden = false;
      el('histWho').textContent = 'Closed conversation';
    });
  });

  qsa('[data-chat]').forEach(function (b) {
    b.addEventListener('click', function () { openDeskChat(b.getAttribute('data-chat')); });
  });
}

/**
 * Abrir é ler. Pegar é um botão.
 *
 * Antes, abrir pegava automaticamente — o que impedia de espreitar
 * antes de decidir, e prendia um lugar a quem só queria ver do que
 * se tratava.
 *
 * Toda a gente lê todas as conversas, incluindo as que estão a
 * decorrer com outro agente: quem cobre um turno precisa de saber o
 * que já foi dito.
 */
async function openDeskChat(chatId) {
  var chat = desk.chats.find(function (c) { return c.chat_id === chatId; });
  if (!chat) return;

  desk.current = chatId;

  try {
    var data = await deskFetch(rotaDaAba('messages') + encodeURIComponent(chatId));
    desk.messages = data.messages || [];
  } catch (e) {
    avisar('Heads up', e.message);
    return;
  }

  el('chatBlank').classList.add('hidden');
  el('chatOpen').classList.remove('hidden');
  // No telemóvel, a lista sai do caminho quando se abre uma
  // conversa: lado a lado num ecrã de 380px dá 190px para cada, e
  // nenhuma das duas funciona nesse espaço.
  document.body.classList.add('chat-open');

  // O parceiro passa a ver que o que escreveu chegou. É daí que vêm
  // as mensagens repetidas quando não há resposta imediata.
  deskFetch('/api/admin/chat/read', { chat_id: chatId }).catch(function () {});

  /**
   * Dizer aos colegas que estou aqui.
   *
   * Ao abrir e depois de meio em meio minuto. Sem isto, dois
   * agentes escrevem ao mesmo tempo sem saber um do outro — e o
   * parceiro recebe duas respostas diferentes à mesma pergunta.
   */
  marcarPresenca(chatId);
  arrancarRelogioResposta(chatAtual());
  // O histórico é do parceiro anterior; trocar de conversa fecha-o.
  el('histPanel').hidden = true;
  el('histRead').hidden = true;
  fecharSnips();

  el('chatWho').textContent = chat.trading_name || chat.legal_name || chat.email;
  el('chatMeta').textContent = [
    chat.email, chat.contact_phone, chat.country, chat.partner_status
  ].filter(Boolean).join('  ·  ');

  // A API dá os minutos decorridos, não a data de abertura. Basta
  // para reconstruir o instante em que começou, e daí o cronómetro
  // conta sozinho a cada segundo.
  var abriuEm = chat.created_at ||
    (chat.minutes_since != null
      ? new Date(Date.now() - Number(chat.minutes_since) * 60000).toISOString()
      : null);

  arrancarRelogio(abriuEm, chat.closed_at ||
    (chat.status === 'resolved' || chat.status === 'closed' ? chat.updated_at : null));

  // A vista traz awaiting_reply_minutes: zero quando a bola está do
  // lado do parceiro, e os minutos de espera quando está do nosso.
  marcarEspera(chat.awaiting_reply_minutes > 0
    ? new Date(Date.now() - chat.awaiting_reply_minutes * 60000).toISOString()
    : null);

  paintChatOwnership(chat);
  renderThread();
  renderChatCtx(chatId);
  renderChatLog(chatId);
  await loadDesk();
  el('chatReply').focus();
}

function deskDay(when) {
  var d = new Date(when);
  if (isNaN(d.getTime())) return '';

  var today = new Date();
  var yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);

  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';

  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long' });
}

function deskClock(when) {
  var d = new Date(when);
  return isNaN(d.getTime()) ? ''
    : d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
}

/**
 * Quem manda nesta conversa, e o que posso fazer.
 *
 * Três situações: é minha, é de outro agente, ou não é de ninguém.
 * Cada uma permite coisas diferentes, e a barra diz qual é sem
 * obrigar a adivinhar pelos botões que aparecem.
 */
/**
 * Pegar uma conversa.
 *
 * Uma conversa que JÁ É MINHA não é um erro. O servidor responde
 * 'already_taken' porque olha só para o assigned_to estar
 * preenchido — não repara que quem está a pedir é o dono.
 *
 * Isto acontecia sempre depois de recarregar a página: a oferta
 * ainda estava no ecrã, carregava-se em atender, e o painel dizia
 * que outro agente tinha ficado com ela. Não tinha: era a própria
 * pessoa.
 */
async function pegarConversa(chatId) {
  var chat = desk.chats.find(function (c) { return c.chat_id === chatId; });

  // Já é minha: abre e pronto.
  if (chat && chat.assigned_to === adminId()) {
    await openDeskChat(chatId);
    return true;
  }

  /**
   * Pegar um chat estando offline é entrar ao serviço.
   *
   * Um agente offline que pega uma conversa está a trabalhar — dizer
   * que está offline seria falso, e o pior é que o som e os avisos
   * ficavam desligados enquanto ele atendia alguém.
   *
   * Só se aplica a offline e unknown. Quem está em break, training,
   * admin ou escalating disse que está ocupado com outra coisa —
   * pegar um chat não desfaz essa decisão, e o estado dele continua
   * a descrever o que está mesmo a fazer.
   *
   * O ajustarActive, mais abaixo, arruma quem estava em live.
   */
  /**
   * Pegar um chat estando offline é entrar ao serviço.
   *
   * Vai direto a Active, sem passar por Live: Live é o estado de
   * quem está pronto e sem tickets, e quem acabou de pegar um tem
   * um. Passar por lá seria um instante a mostrar uma coisa que
   * não é verdade.
   *
   * O servidor faz o mesmo no claim_chat — isto é só para o ecrã
   * não esperar pela resposta.
   */
  if (desk.state === 'offline' || desk.state === 'unknown') {
    desk.state = 'active';
    marcarEstadoDesde(0);
    document.body.setAttribute('data-duty', 'active');
    pintarDuty();
  }

  try {
    await deskFetch(rotaDaAba('claim'), { chat_id: chatId });
  } catch (e) {
    await loadDesk();

    // Recarrega e volta a ver: entre o pedido e a resposta pode
    // ter mudado, e o caso mais comum é ter ficado minha.
    var agora = desk.chats.find(function (c) { return c.chat_id === chatId; });

    if (agora && agora.assigned_to === adminId()) {
      await openDeskChat(chatId);
      return true;
    }

    avisar('Heads up', e.message);
    return false;
  }

  await loadDesk();
  await openDeskChat(chatId);
  ajustarActive();
  return true;
}

/**
 * O Live e o Active mudam sozinhos, no Postgres.
 *
 * Um gatilho na partner_chats e na support_chats chama o
 * sync_agent_state sempre que uma conversa muda de dono ou fecha.
 * Fazê-lo aqui obrigaria a lembrar em seis sítios diferentes, e
 * bastava esquecer um.
 *
 * Esta função só ACERTA O ECRÃ com o que o servidor já decidiu.
 */
function ajustarActive() {
  if (desk.state !== 'live' && desk.state !== 'active') return;

  var meus = (desk.chats || []).filter(function (c) {
    return c.assigned_to === adminId() && c.status === 'open';
  }).length;

  var devia = meus > 0 ? 'active' : 'live';

  if (desk.state === devia) return;

  // Só o ecrã. A gravação já aconteceu no servidor.
  desk.state = devia;
  marcarEstadoDesde(0);
  document.body.setAttribute('data-duty', devia);
  el('dutyNote').textContent = STATE_NOTES[devia] || '';
  pintarDuty();
}

/**
 * Quem manda nesta conversa, e o que se pode fazer nela.
 *
 * Três situações, não duas:
 *
 *   é minha        respondo, fecho, escalo
 *   está livre     pego e passa a ser minha
 *   é de outro     ENTRO — leio, escrevo, e o dono continua a ser
 *                  ele. Ou tomo conta, se ele desapareceu.
 *
 * A terceira não existia: o painel recusava e ficava por ali. Um
 * agente que precisasse de ajuda não a conseguia pedir, e uma
 * conversa de alguém que saiu ficava presa para sempre.
 */
function paintChatOwnership(chat) {
  var mine = chat.assigned_to === adminId();
  var free = !chat.assigned_to;
  var bar = el('chatClaimBar');

  // Estou dentro se é minha, ou se entrei nela.
  var dentro = mine || (chat.watchers || []).some(function (w) {
    return w.agent_id === adminId();
  });

  el('chatUrgentBtn').classList.toggle('hidden', !mine);
  el('chatCloseBtn').classList.toggle('hidden', !mine);
  // Escalar é passar uma conversa MINHA a outra pessoa. Não faz
  // sentido em conversas que não tenho.
  el('chatEscalateBtn').classList.toggle('hidden', !mine);
  el('chatReleaseBtn').classList.toggle('hidden', !mine);
  el('chatUrgentBtn').textContent = chat.urgent ? 'Remove urgent' : 'Flag urgent';

  // Escrever: qualquer pessoa que esteja dentro. Só ler quando não
  // se entrou ainda.
  document.querySelector('.desk-foot').classList.toggle('locked', !dentro);
  document.querySelector('.desk-mode').classList.toggle('locked', !dentro);

  if (mine) {
    bar.classList.add('hidden');
    pintarQuemEsta(chat);
    return;
  }

  if (free) {
    el('chatClaimText').textContent = 'Waiting for someone.';
    el('chatTakeBtn').textContent = 'Take this chat';
    el('chatJoinBtn').classList.add('hidden');
  } else {
    /**
     * Já tem dono. Dizer QUEM, e dar duas saídas.
     *
     * O painel dizia "already taken" e pronto. Saber que é o Rick
     * muda tudo: sabe-se a quem perguntar, e se ele está ali ao
     * lado resolve-se numa frase.
     */
    var quem = chat.assigned_agent_name || 'another agent';

    el('chatClaimText').textContent = 'Session with ' + quem + '.';
    el('chatTakeBtn').textContent = 'Take it over';
    el('chatJoinBtn').classList.remove('hidden');
  }

  el('chatTakeBtn').disabled = false;
  bar.classList.remove('hidden');

  pintarQuemEsta(chat);
}

/**
 * Os outros agentes que estão nesta conversa.
 *
 * Sem isto, dois agentes escrevem ao mesmo tempo sem saber um do
 * outro — e o parceiro recebe duas respostas diferentes à mesma
 * pergunta.
 */
// ============================================================
// O RELÓGIO DA RESPOSTA
//
// Conta desde a última mensagem do parceiro. Aos três minutos fica
// âmbar, aos cinco vermelho — os mesmos limites que o servidor usa
// para marcar a conversa como atrasada.
//
// O agente promete três minutos e não tinha como saber se os
// estava a cumprir.
// ============================================================
var relogio = { desde: null, timer: null };

function arrancarRelogioResposta(chat) {
  pararRelogioResposta();

  var caixa = el('replyClock');
  if (!caixa || caixa.__missing) return;

  // Só conta se a bola está do NOSSO lado: eles escreveram e
  // ninguém respondeu ainda.
  var espera = chat && chat.awaiting_reply_minutes;

  if (!espera && espera !== 0) { caixa.hidden = true; return; }

  if (!chat.last_user_msg_at && !chat.last_message_at) {
    caixa.hidden = true;
    return;
  }

  // O servidor diz há quantos minutos espera. Daí para a frente o
  // browser conta — mas parte sempre do número dele.
  relogio.desde = Date.now() - (Number(espera) || 0) * 60000;

  caixa.hidden = false;
  pintarRelogioResposta();

  relogio.timer = setInterval(pintarRelogioResposta, 1000);
}

function pintarRelogioResposta() {
  var caixa = el('replyClock');
  if (!caixa || caixa.__missing || !relogio.desde) return;

  var seg = Math.max(0, Math.round((Date.now() - relogio.desde) / 1000));

  el('rcTime').textContent =
    Math.floor(seg / 60) + ':' + String(seg % 60).padStart(2, '0');

  // Os mesmos limites do servidor. Se divergissem, o agente veria
  // verde enquanto a conversa já estava marcada como atrasada.
  caixa.classList.toggle('warn', seg >= 180 && seg < 300);
  caixa.classList.toggle('late', seg >= 300);

  el('rcLabel').textContent = seg >= 300
    ? 'they have been waiting'
    : seg >= 180
      ? 'past the three minutes'
      : 'since they wrote';
}

function pararRelogioResposta() {
  if (relogio.timer) { clearInterval(relogio.timer); relogio.timer = null; }
  relogio.desde = null;

  var caixa = el('replyClock');
  if (caixa && !caixa.__missing) {
    caixa.hidden = true;
    caixa.classList.remove('warn', 'late');
  }
}

/**
 * Diz que estou nesta conversa, e continua a dizê-lo.
 *
 * De trinta em trinta segundos. O servidor considera ausente quem
 * não dá sinal há dois minutos — quatro batidas de folga, porque
 * uma rede lenta não deve fazer um agente desaparecer da vista dos
 * colegas.
 */
var presencaTimer = null;

function marcarPresenca(chatId) {
  pararPresenca();

  if (!chatId) return;

  var apoio = audAtual === 'customers' || audAtual === 'agents';
  var chat = chatAtual();
  var modo = (chat && chat.assigned_to === adminId()) ? 'handling' : 'viewing';

  var bater = function () {
    deskFetch('/api/admin/chat/presence', {
      chat_id: chatId,
      kind: apoio ? 'support' : 'partner',
      mode: modo
    }).catch(function () {});
  };

  bater();
  presencaTimer = setInterval(bater, 30000);
}

function pararPresenca() {
  if (presencaTimer) { clearInterval(presencaTimer); presencaTimer = null; }
}

function pintarQuemEsta(chat) {
  var caixa = el('chatWatchers');
  if (!caixa || caixa.__missing) return;

  var outros = (chat.watchers || []).filter(function (w) {
    return w.agent_id !== adminId() && w.agent_id !== chat.assigned_to;
  });

  if (!outros.length) {
    caixa.hidden = true;
    return;
  }

  /**
   * Quem atende e quem lê são coisas diferentes.
   *
   * Antes apareciam iguais, e o agente não sabia se podia escrever
   * ou se atrapalhava. "Rick is in this chat" e "Rick is viewing"
   * levam a decisões opostas.
   */
  caixa.hidden = false;

  caixa.innerHTML = outros.map(function (w) {
    var atende = w.mode === 'handling';

    return '<span class="wt">' + escapeHtml(iniciais(w.name || '?')) + '</span>' +
      '<span class="wt-mode ' + (atende ? 'handling' : 'viewing') + '">' +
      escapeHtml(w.name || 'Someone') + ' is ' +
      (atende ? 'in this chat' : 'viewing') + '</span>';
  }).join('');
}

el('chatTakeBtn').addEventListener('click', async function () {
  if (!desk.current) return;

  var chat = chatAtual();
  var apoio = audAtual === 'customers' || audAtual === 'agents';

  // Livre: pega-se e passa a ser minha.
  if (!chat.assigned_to) {
    await pegarConversa(desk.current);
    return;
  }

  /**
   * Tem dono. Tomar conta tira-lha.
   *
   * Só faz sentido se ele saiu mesmo. Se está a trabalhar, o botão
   * ao lado — "Join" — deixa entrar sem tirar nada a ninguém.
   */
  var quem = chat.assigned_agent_name || 'the other agent';

  if (!await perguntar('Take it over',
      'This moves the conversation from ' + quem + ' to you.\n\n' +
      'They lose it from their list. If they are still working, use Join ' +
      'instead — you can both be in it.')) return;

  try {
    await deskFetch('/api/admin/chat/takeover', {
      chat_id: desk.current,
      kind: apoio ? 'support' : 'partner'
    });

    await loadDesk();
    await openDeskChat(desk.current);
  } catch (e) {
    avisar('Could not take it over', e.message);
  }
});

/**
 * Entrar sem tirar a ninguém.
 *
 * Os dois ficam, os dois podem escrever, e o nome vai em cada
 * mensagem. Um agente que precise de ajuda passa a poder pedi-la
 * sem escalar formalmente — e um supervisor pode acompanhar sem
 * interromper.
 */
el('chatJoinBtn').addEventListener('click', async function () {
  if (!desk.current) return;

  var apoio = audAtual === 'customers' || audAtual === 'agents';

  el('chatJoinBtn').disabled = true;

  try {
    await deskFetch('/api/admin/chat/join', {
      chat_id: desk.current,
      kind: apoio ? 'support' : 'partner'
    });

    await loadDesk();
    await openDeskChat(desk.current);
  } catch (e) {
    avisar('Could not join', e.message);
  } finally {
    el('chatJoinBtn').disabled = false;
  }
});

/** A conversa aberta, ou um objeto vazio para não rebentar. */
function chatAtual() {
  return (desk.chats || []).find(function (c) {
    return c.chat_id === desk.current;
  }) || {};
}

function renderThread() {
  var box = el('chatThread');
  var all = desk.messages;
  var html = '';
  var lastDay = '';

  all.forEach(function (m, i) {
    var previous = all[i - 1];
    var next = all[i + 1];
    var mine = m.sender === 'admin';

    var day = deskDay(m.created_at);
    if (day && day !== lastDay) {
      html += '<div class="d-day">' + escapeHtml(day) + '</div>';
      lastDay = day;
    }

    // Agrupar o que é da mesma pessoa: só a última de uma sequência
    // leva a hora e o canto cortado.
    var turn = !previous || previous.sender !== m.sender || previous.internal ||
      deskDay(previous.created_at) !== day;
    var last = !next || next.sender !== m.sender || next.internal ||
      deskDay(next.created_at) !== day;

    // As notas não têm lado: não são de ninguém para ninguém, são
    // sobre a conversa.
    if (m.internal) {
      html += '<div class="d-note' + (m.system ? ' sys' : '') + '">' +
        '<span class="who">' + escapeHtml(m.system ? 'System' : (m.sender_name || 'note')) +
        ' · ' + escapeHtml(deskClock(m.created_at)) + '</span>' +
        escapeHtml(m.body || '') + '</div>';
      return;
    }

    /**
     * A fotografia, só na primeira mensagem de uma sequência.
     *
     * Repeti-la em cinco mensagens seguidas da mesma pessoa é ruído
     * — mas o espaço fica reservado nas outras, senão as bolhas
     * saltavam para a esquerda a meio de uma sequência.
     */
    var quem = mine
      ? { av: m.sender_avatar, nome: m.sender_name || 'Airportlink' }
      : { av: chatAtual().partner_avatar,
          nome: chatAtual().trading_name || chatAtual().legal_name || 'Partner' };

    var foto = avatarUrl(quem.av);

    html += '<div class="d-row ' + (mine ? 'mine' : 'theirs') +
      (turn ? ' turn' : '') + (last ? ' last' : '') + '">' +
      (foto
        ? '<img class="msg-pic" src="' + escapeHtml(foto) + '" alt="">'
        : '<span class="msg-ini">' + escapeHtml(iniciais(quem.nome)) + '</span>') +
      '<div>' +
      '<div class="d-bub">' +
      (m.attachment_path
        ? '<a class="d-file" href="#" data-dfile="' + escapeHtml(m.attachment_path) + '">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" ' +
          'stroke-linecap="round" stroke-linejoin="round">' +
          '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>' +
          '<path d="M14 2v6h6"/></svg><span>' +
          escapeHtml(m.attachment_name || 'attachment') + '</span></a>' +
          (m.body ? '<div style="margin-top:8px">' + escapeHtml(m.body) + '</div>' : '')
        : escapeHtml(m.body || '')) + '</div>' +
      (last
        ? '<div class="d-meta">' +
          escapeHtml(mine ? (m.sender_name || 'you') : (m.sender_name || 'partner')) + ' · ' +
          escapeHtml(deskClock(m.created_at)) + '</div>'
        : '') +
      '</div></div>';
  });

  box.innerHTML = html;
  box.scrollTop = box.scrollHeight;

  // Endereço assinado, válido um minuto. O balde é privado: um link
  // permanente seria um ficheiro exposto para sempre a quem o
  // apanhasse.
  qsa('#chatThread [data-dfile]').forEach(function (a) {
    a.addEventListener('click', async function (e) {
      e.preventDefault();

      try {
        var r = await client.storage.from('chat-attachments')
          .createSignedUrl(a.getAttribute('data-dfile'), 60);

        if (r.error) throw new Error(r.error.message);
        window.open(r.data.signedUrl, '_blank', 'noopener');
      } catch (err) {
        avisar('Heads up', 'Could not open that file: ' + err.message);
      }
    });
  });
}

// Responder ou anotar.
var deskMode = 'reply';

qsa('.dm').forEach(function (b) {
  b.addEventListener('click', function () {
    qsa('.dm').forEach(function (x) { x.classList.remove('active'); });
    b.classList.add('active');
    deskMode = b.getAttribute('data-mode');

    el('chatReply').placeholder = deskMode === 'note'
      ? 'Internal note — the partner never sees this'
      : 'Write your reply';

    document.querySelector('.desk-foot').classList.toggle('note', deskMode === 'note');
    el('chatSendBtn').textContent = deskMode === 'note' ? 'Save note' : 'Send';
    el('chatReply').focus();
  });
});

el('deskAttach').addEventListener('click', function () { el('deskFile').click(); });

el('deskFile').addEventListener('change', async function () {
  var file = this.files && this.files[0];
  if (!file || !desk.current) return;

  if (file.size > 10 * 1024 * 1024) {
    el('chatErr').textContent = 'That file is over the 10 MB limit.';
    el('chatErr').style.display = 'block';
    this.value = '';
    return;
  }

  el('deskAttach').disabled = true;

  try {
    var ext = (file.name.split('.').pop() || 'bin').toLowerCase();
    var path = adminId() + '/chat/' + Date.now() + '.' + ext;

    var up = await client.storage.from('chat-attachments').upload(path, file, {
      contentType: file.type || 'application/octet-stream'
    });

    if (up.error) throw new Error(up.error.message);

    var res = await deskFetch(rotaDaAba('send'), {
      chat_id: desk.current,
      body: el('chatReply').value.trim() || file.name,
      attachment_path: path,
      attachment_name: file.name,
      internal: deskMode === 'note'
    });

    desk.messages.push(res.message);
    // Respondeu: a espera acaba aqui, sem ter de aguardar o próximo
    // carregamento da fila para o aviso desaparecer.
    if (deskMode !== 'note') marcarEspera(null);
    renderThread();
    el('chatReply').value = '';
    await loadDesk();
  } catch (e) {
    el('chatErr').textContent = e.message;
    el('chatErr').style.display = 'block';
  } finally {
    el('deskAttach').disabled = false;
    el('deskFile').value = '';
  }
});

el('chatSendBtn').addEventListener('click', async function () {
  var body = el('chatReply').value.trim();
  if (!body || !desk.current) return;

  el('chatErr').style.display = 'none';
  el('chatSendBtn').disabled = true;

  try {
    var res = await deskFetch(rotaDaAba('send'), {
      chat_id: desk.current,
      body: body,
      internal: deskMode === 'note',
      sender_name: deskMode === 'note' ? (deskDisplayName || 'note') : deskDisplayName
    });

    desk.messages.push(res.message);
    renderThread();
    el('chatReply').value = '';
    await loadDesk();
  } catch (e) {
    el('chatErr').textContent = e.message;
    el('chatErr').style.display = 'block';
  } finally {
    el('chatSendBtn').disabled = false;
    el('chatReply').focus();
  }
});

// ---------- o nome que o parceiro lê ----------
//
// Guardado no servidor, não no browser: tem de ser o mesmo em todas
// as conversas e em qualquer computador onde este agente entre.
var deskDisplayName = null;

/**
 * O nome que o parceiro vê quando este agente responde.
 *
 * Guardado no servidor, mas com uma cópia local. A razão: o
 * /api/admin/team lê da vista support_team, que só mostra agentes
 * ao serviço. Quem grava o nome antes de se pôr em Live não
 * aparece nessa lista — e ao recarregar a página o nome parecia
 * ter-se perdido, quando na verdade estava gravado.
 *
 * A cópia local resolve o arranque; o servidor continua a ser a
 * verdade quando ele responde.
 */
var NAME_KEY = 'airportlink-agent-name';

// ============================================================
// ABAS DE MARCA
//
// Os mesmos agentes atendem três marcas com filas separadas. A aba
// diz onde se está, e a escolha fica guardada — quem trabalha
// sobretudo numa não a tem de escolher todas as manhãs.
//
// Com uma marca só, nada disto aparece.
// ============================================================
function pintarMarcas() {
  var barra = el('brandTabs');
  if (!barra || barra.__missing) return;

  // Uma aba sozinha é ruído. Aparece a partir da segunda marca.
  if (BRANDS.length < 2) { barra.hidden = true; return; }

  barra.hidden = false;

  barra.innerHTML = BRANDS.map(function (b) {
    var esperam = contarEspera(b.key);

    return '<button class="brand-tab' + (b.key === brandAtual ? ' on' : '') +
      '" data-brand="' + escapeHtml(b.key) + '" type="button"' +
      ' style="--brand-color:' + escapeHtml(b.color || 'currentColor') + '">' +
      '<span class="brand-dot"></span>' +
      escapeHtml(b.label) +
      '<span class="brand-n' + (esperam ? '' : ' zero') + '">' + esperam + '</span>' +
      '</button>';
  }).join('');

  qsa('[data-brand]').forEach(function (b) {
    b.addEventListener('click', function () {
      trocarMarca(b.getAttribute('data-brand'));
    });
  });
}

/** Quantas conversas dessa marca estão à espera de alguém. */
function contarEspera(chave) {
  // Sobre desk.todas e não desk.chats: o segundo já está filtrado
  // pela marca ativa, e daria sempre zero nas outras abas.
  return (desk.todas || desk.chats || []).filter(function (c) {
    return !c.assigned_to && c.unread_for_admin > 0 &&
      (c.brand || 'airportlink') === chave;
  }).length;
}

async function trocarMarca(chave) {
  if (chave === brandAtual) return;

  brandAtual = chave;
  gravarPref({ brand: chave });

  // A conversa aberta é da marca anterior: fecha-se antes de trocar,
  // senão ficava no ecrã sem pertencer à fila que se está a ver.
  desk.current = null;
  pararRelogio();
  el('chatOpen').classList.add('hidden');
  el('chatBlank').classList.remove('hidden');

  pintarMarcas();
  await loadDesk();
}

/**
 * A marca de uma conversa.
 *
 * As conversas criadas antes de haver marcas não têm a coluna
 * preenchida. São todas da Airportlink, porque era a única que
 * existia — e assumir isso é melhor do que as fazer desaparecer da
 * fila por não terem marca.
 */
function marcaDe(c) {
  return c.brand || 'airportlink';
}

// ============================================================
// PÚBLICOS
//
// Clientes, motoristas e agências. Um cliente pergunta pela
// reserva, um motorista pelo pagamento, uma agência pela comissão
// — misturá-los na mesma fila obriga o agente a mudar de cabeça a
// cada conversa.
//
// Hoje só os motoristas têm fila própria: os clientes usam a
// support_chats, noutro separador, e as agências ainda não têm
// chat nenhum. As abas existem para quando tiverem, e as vazias
// dizem-no em vez de fingirem uma fila.
// ============================================================
// ============================================================
// A FILA DE ESCALADAS
//
// Só supervisores. Uma conversa escalada sai da fila normal —
// deixá-la lá significa que um agente a pode pegar outra vez, e o
// parceiro explica tudo pela terceira vez à mesma pessoa que já
// não sabia responder.
// ============================================================
var escaladas = [];

/** O nome de quem escalou, tirado da nota. */
function quemEscalou(nota) {
  var m = /^Escalated by ([^:]+):/.exec(String(nota || ''));
  return m ? m[1].trim() : 'an agent';
}

/** A nota sem o prefixo do nome, que já aparece à parte. */
function semPrefixo(nota) {
  return String(nota || '').replace(/^Escalated by [^:]+:\s*/, '');
}

async function carregarEscaladas() {
  if (!souSupervisor) return;

  try {
    var r = await deskFetch('/api/admin/escalations');
    escaladas = r.chats || [];
  } catch (e) {
    escaladas = [];
  }

  pintarAudTabs();
  if (audAtual === 'escalated') renderDesk();
}

/**
 * A aba de público. Vem do servidor, como tudo o resto.
 *
 * Se dois agentes abrirem o painel, veem o mesmo — porque tudo
 * vem do mesmo sítio.
 */
var audAtual = 'drivers';

/**
 * As abas de público, com o estado de cada fila.
 *
 *   verde   nada à espera
 *   azul    conversas em curso
 *   laranja alguém à espera de resposta
 *
 * O laranja ganha sempre: uma fila com gente à espera e conversas
 * em curso ao mesmo tempo é uma fila com gente à espera.
 */
/**
 * A pesquisa nas conversas.
 *
 * O separador de clientes já tinha pesquisa; o de parceiros não. Um
 * agente que atenda os três públicos não devia ter de mudar de
 * método conforme quem está do outro lado.
 */
// ============================================================
// AS TRÊS VISTAS DA FILA
//
// Estavam dentro de uma lista escondida, onde ninguém as
// encontrava. São a coisa mais usada do painel.
//
// Uma conversa com dono CONTINUA a aparecer — só noutra vista. Dois
// agentes podem trabalhar a mesma, e esconder o que já tem alguém
// impedia isso.
// ============================================================
var vistaAtual = 'waiting';

qsa('[data-qview]').forEach(function (b) {
  b.addEventListener('click', function () {
    vistaAtual = b.getAttribute('data-qview');

    qsa('[data-qview]').forEach(function (x) {
      x.classList.toggle('on', x === b);
    });

    // As fechadas vêm de outra chamada: são muitas e raramente se
    // olha para elas.
    if (vistaAtual === 'closed' && !fechadas.length) {
      carregarFechadas();
    } else {
      renderDesk();
    }
  });
});

/** Os contadores de cada vista, para se ver sem clicar. */
function pintarVistas(lista) {
  var meu = adminId();

  var n = {
    waiting: lista.filter(function (c) { return !c.assigned_to; }).length,
    taken: lista.filter(function (c) {
      return c.assigned_to && c.assigned_to !== meu;
    }).length,
    mine: lista.filter(function (c) { return c.assigned_to === meu; }).length
  };

  ['waiting', 'taken', 'mine'].forEach(function (k) {
    var el2 = el('qn' + k.charAt(0).toUpperCase() + k.slice(1));
    if (el2 && !el2.__missing) el2.textContent = n[k];
  });

  // A vista de quem espera fica vermelha quando há alguém à
  // espera. É a única que grita, porque é a única onde esperar
  // custa.
  var wb = document.querySelector('[data-qview="waiting"]');
  if (wb) wb.classList.toggle('hot', n.waiting > 0);
}

function filtrarConversas(lista) {
  var q = (el('deskSearch').value || '').trim().toLowerCase();
  return (lista || []).filter(function (c) {
    if (q) {
      var campos = [c.trading_name, c.legal_name, c.email, c.ticket_number,
                    c.subject, c.last_message_text, c.contact_phone, c.country];
      var achou = campos.some(function (x) {
        return String(x || '').toLowerCase().indexOf(q) !== -1;
      });
      if (!achou) return false;
    }

    /**
     * A vista decide o que se mostra.
     *
     * Uma conversa com dono CONTINUA a aparecer — só noutra vista.
     * Dois agentes podem trabalhar a mesma, e esconder o que já tem
     * alguém impedia isso.
     */
    if (vistaAtual === 'waiting') return !c.assigned_to;
    if (vistaAtual === 'mine') return c.assigned_to === adminId();
    if (vistaAtual === 'taken') return c.assigned_to && c.assigned_to !== adminId();
    // 'closed' esconde as abertas: as fechadas vêm de outra lista.
    if (vistaAtual === 'closed') return false;

    return true;
  });
}

el('deskSearch').addEventListener('input', renderDesk);


el('deskSearchClear').addEventListener('click', function () {
  el('deskSearch').value = '';
  renderDesk();
});

/**
 * Grava uma preferência no servidor.
 *
 * Sem esperar pela resposta: mudar de aba tem de ser imediato no
 * ecrã, e se a gravação falhar o pior que acontece é a próxima
 * sessão abrir na aba anterior.
 */
function gravarPref(o) {
  deskFetch('/api/admin/prefs', o).catch(function (e) {
    console.log('[desk] pref not saved:', e.message);
  });
}

function pintarAudTabs() {
  /**
   * As abas só existem onde fazem sentido.
   *
   * Vivem fora dos painéis para não desaparecerem ao mudar de
   * público — mas isso significa que apareceriam também nas
   * reservas e nas finanças, onde não querem dizer nada.
   */
  var emChat = activeTab === 'chatTab' || activeTab === 'supportTab';
  el('audTabs').classList.toggle('hidden', !emChat);

  if (!emChat) return;

  var todas = desk.todas || desk.chats || [];

  var esperam = todas.filter(function (c) {
    return !c.assigned_to && c.unread_for_admin > 0;
  }).length;

  var emCurso = todas.filter(function (c) {
    return c.assigned_to && c.status === 'open';
  }).length;

  // Hoje só os motoristas têm fila própria. Os clientes vivem noutro
  // separador e as agências ainda não têm chat — daí os contadores
  // deles ficarem a zero.
  var estado = {
    drivers: { espera: esperam, curso: emCurso },
    customers: { espera: alerts.supportTab || 0, curso: 0 },
    agents: { espera: 0, curso: 0 },
    // Uma escalada à espera é o caso mais urgente que existe: já
    // passou por um agente que não conseguiu resolver.
    escalated: { espera: escaladas.length, curso: 0 }
  };

  // A aba de escaladas só existe para supervisores.
  el('audTabEsc').classList.toggle('hidden', !souSupervisor);

  qsa('[data-aud]').forEach(function (b) {
    var qual = b.getAttribute('data-aud');
    var e = estado[qual] || { espera: 0, curso: 0 };

    b.classList.toggle('active', qual === audAtual);
    b.classList.toggle('waiting', e.espera > 0);
    b.classList.toggle('busy', e.espera === 0 && e.curso > 0);
  });

  var contadores = {
    drivers: 'audNDrivers', customers: 'audNCustomers',
    agents: 'audNAgents', escalated: 'audNEsc'
  };

  Object.keys(contadores).forEach(function (qual) {
    var n = el(contadores[qual]);
    if (!n || n.__missing) return;

    var e = estado[qual] || { espera: 0 };
    n.textContent = e.espera;
    n.classList.toggle('hidden', !e.espera);
  });
}

qsa('[data-aud]').forEach(function (b) {
  b.addEventListener('click', function () {
    var qual = b.getAttribute('data-aud');
    if (qual === audAtual) return;

    audAtual = qual;
    gravarPref({ audience: qual });

    pintarAudTabs();

    if (qual === 'escalated') {
      switchTab('chatTab');
      carregarEscaladas();
      return;
    }

    // Clientes e agências têm fila própria, com a mesma forma da
    // dos parceiros. O separador é o mesmo — o que muda é de onde
    // vêm as conversas.
    switchTab('chatTab');
    loadDesk();
  });
});

/** Esconde o que este cargo não pode ver. */
function aplicarCargo() {
  qsa('[data-tab]').forEach(function (b) {
    var tab = b.getAttribute('data-tab');
    // As finanças são só de supervisores. Esconder o botão não
    // protege nada — quem quiser chama a rota — mas mostrar uma
    // porta que se abre com um erro é pior do que não a mostrar.
    if (tab === 'financeTab') {
      b.classList.toggle('hidden', !souSupervisor);
    }
  });

  document.body.setAttribute('data-role', meuCargo);
}

/**
 * Uma chamada, e o painel sabe tudo.
 *
 * Antes eram três: a equipa, os atalhos e o cargo. Cada uma custa
 * cerca de dois segundos no plano gratuito do Render, e o painel
 * não podia desenhar nada antes de saber quem estava a olhar.
 *
 * O agent_session devolve nome, cargo, avatar, estado, segundos no
 * estado, preferências e atalhos — do servidor, que é a única
 * fonte. O browser não guarda nada disto entre sessões.
 */
async function iniciarApoio() {
  var ses;

  try {
    ses = await deskFetch('/api/admin/session');
  } catch (e) {
    console.error('[desk] session:', e.message);

    // Sem sessão não se inventa nada. Offline é o estado seguro:
    // melhor não receber conversas do que julgar que se está a
    // receber e não estar.
    desk.state = 'offline';
    document.body.setAttribute('data-duty', 'offline');
    pintarDuty();
    return;
  }

  // ---------- quem sou ----------
  deskDisplayName = ses.display_name || null;
  meuAvatar = ses.avatar_path || null;
  souSupervisor = Boolean(ses.is_supervisor);

  paintDisplayName();
  aplicarCargo();

  // ---------- o que prefiro ----------
  var prefs = ses.prefs || {};

  if (prefs.audience) audAtual = prefs.audience;

  if (prefs.brand && BRANDS.some(function (b) { return b.key === prefs.brand; })) {
    brandAtual = prefs.brand;
  }

  /**
   * O som não tem interruptor: segue o estado.
   *
   * Um agente em Live ouve; em break ou offline não. A preferência
   * existe na base para quando houver botão, mas nada a lê hoje —
   * e ler uma coisa que ninguém escreve seria pior do que não a
   * ler de todo.
   */

  // ---------- em que estado estou ----------
  desk.state = ses.state || 'offline';

  /**
   * Os segundos vêm do relógio do Postgres.
   *
   * É o único número que não depende da hora do computador de quem
   * está a olhar — e é por isso que um refresh deixa de reiniciar
   * a contagem.
   */
  marcarEstadoDesde(ses.state_seconds || 0);

  document.body.setAttribute('data-duty', desk.state);
  el('dutyNote').textContent = STATE_NOTES[desk.state] || '';

  pintarDuty();
  pintarMarcas();
  pintarAudTabs();

  // O som fica pronto se o estado recebe conversas. Sem gesto do
  // utilizador o browser recusa, mas o desbloqueio fica agendado
  // para o primeiro clique.
  if (desk.state === 'live' || desk.state === 'active') unlockAudio();

  // ---------- os atalhos ----------
  snips.todos = (ses.snippets || []).map(function (x) {
    return { id: x.id, shortcut: x.shortcut, title: x.title, body: x.body, mine: x.mine };
  });

  // A fila de escaladas, se for supervisor. Um caso escalado à
  // espera é o mais urgente que existe: já passou por alguém que
  // não conseguiu resolver.
  if (souSupervisor) carregarEscaladas();
}

/**
 * O estado ao recarregar a página.
 *
 * A presença vive no servidor e expira sozinha ao fim de três
 * minutos sem batida. O painel arrancava sempre em 'offline' e não
 * perguntava — quem recarregasse a página aparecia offline para os
 * outros e deixava de receber chamadas sem dar por isso.
 *
 * Agora pergunta. Se o servidor diz que este agente estava em Live,
 * retoma Live e volta a bater o ponto.
 */
/**
 * O estado tem de sair sempre de 'unknown'.
 *
 * Se o /api/admin/team falhar — e falha quando o serviço de drivers
 * está a acordar — o painel ficava em 'unknown' para sempre. Com a
 * regra de CSS que esbatia os botões nesse estado, isso deixava-os
 * a parecer desativados sem nada o explicar.
 *
 * Agora há um limite: passados oito segundos assume-se offline, que
 * é o estado seguro. Melhor mostrar offline e deixar clicar do que
 * mostrar um limbo em que nada responde.
 */
setTimeout(function () {
  if (document.body.getAttribute('data-duty') !== 'unknown') return;

  // A presença não chegou. Isto acontece quando o serviço de
  // drivers está a acordar, e pode levar dez segundos.
  //
  // Assume-se offline porque é o estado seguro — melhor não receber
  // chamadas do que julgar que se está a receber. Mas só ao fim de
  // oito segundos: até lá os botões estão escondidos, e um espaço
  // vazio é mais honesto do que um estado inventado.
  console.warn('[desk] presence never arrived — assuming offline.');

  document.body.setAttribute('data-duty', 'offline');
  desk.state = 'offline';
  el('dutyNote').textContent = STATE_NOTES.offline;
  pintarDuty();
}, 8000);

async function loadDisplayName() {
  /**
   * O nome vem do servidor, e só de lá.
   *
   * Havia aqui uma leitura do localStorage para o campo aparecer
   * preenchido de imediato. Parecia inofensivo e não era: dois
   * agentes no mesmo computador partilham o localStorage, e o
   * segundo a entrar via o nome do primeiro no seu próprio painel.
   *
   * Agora fica vazio até o servidor responder. Meio segundo de
   * espera vale mais do que um nome errado.
   */
  paintDisplayName();

  // O pedido ao servidor é feito pelo iniciarApoio, que aproveita
  // a mesma resposta para o estado. Aqui só se pinta o que há.
  paintDisplayName();
}

function paintDisplayName() {
  el('deskNameText').textContent = deskDisplayName || 'Set your name';
  el('deskName').classList.toggle('unset', !deskDisplayName);
}

el('deskName').addEventListener('click', async function () {
  var name = await pedirTexto(
    'Your display name',
    'What name should partners see when you reply?\n\n' +
    'A first name works well. They are talking to a person, not to a brand.',
    deskDisplayName || '');

  if (name === null) return;

  if (name.length < 2) {
    await avisar('Too short', 'Use at least two characters.');
    return;
  }

  try {
    await deskFetch('/api/admin/name', { name: name });
    deskDisplayName = name;
    
    paintDisplayName();
    pintarDuty();
  } catch (e) {
    avisar('Heads up', e.message);
  }
});

el('chatReply').addEventListener('keydown', function (e) {
  var aberto = !el('snipBox').hidden;

  // Com a lista aberta, as setas e o Enter pertencem-lhe. Sem isto,
  // o Enter enviava a mensagem a meio de escolher uma resposta.
  if (aberto) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      snips.escolhido += (e.key === 'ArrowDown' ? 1 : -1);
      if (snips.escolhido < 0) snips.escolhido = snips.vistos.length - 1;
      if (snips.escolhido >= snips.vistos.length) snips.escolhido = 0;
      pintarSnips(termoAtual());
      return;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      usarSnip(snips.vistos[snips.escolhido]);
      return;
    }
    if (e.key === 'Escape') { e.preventDefault(); fecharSnips(); return; }
  }

  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); el('chatSendBtn').click(); }
});

/** O que se escreveu depois da última barra. */
function termoAtual() {
  var t = el('chatReply').value;
  var i = t.lastIndexOf('/');
  if (i < 0) return null;
  // Uma barra a meio de uma palavra não é um atalho: "24/7" não
  // devia abrir a lista.
  if (i > 0 && !/\s/.test(t[i - 1])) return null;
  var depois = t.slice(i);
  return /\s/.test(depois) ? null : depois;
}

el('chatReply').addEventListener('input', function () {
  var t = termoAtual();
  if (t === null) return fecharSnips();
  snips.escolhido = 0;
  pintarSnips(t);
});

el('chatReply').addEventListener('blur', function () {
  // Um atraso curto, senão o clique numa resposta perde-se porque
  // a lista fecha antes de o clique chegar.
  setTimeout(fecharSnips, 150);
});

// ---------- histórico ----------
el('deskBack').addEventListener('click', function () {
  // Volta à lista no telemóvel. A conversa continua aberta — só
  // sai da frente.
  document.body.classList.remove('chat-open');
});

el('chatHistBtn').addEventListener('click', function () {
  var chat = desk.chats.find(function (c) { return c.chat_id === desk.current; });
  if (!chat) return;
  abrirHistorico(chat.partner_id,
    chat.trading_name || chat.legal_name || chat.email);
});

el('histClose').addEventListener('click', function () {
  el('histPanel').hidden = true;
});

el('histBack').addEventListener('click', function () {
  el('histRead').hidden = true;
});

// ============================================================
// COMO A CONVERSA ACABOU
//
// Era um botão sem pergunta. "Resolvido" e "o parceiro
// desapareceu" contavam o mesmo no relatório, e não são a mesma
// coisa de todo — uma diz que o serviço funcionou, a outra que
// alguém ficou por atender.
// ============================================================
var fecho = { motivo: 'resolved' };
var fechadas = [];

/**
 * As conversas que fechei.
 *
 * A fila só traz as abertas e as das últimas 24 horas — uma
 * conversa fechada ontem desaparecia de todo lado.
 */
async function carregarFechadas() {
  try {
    var r = await deskFetch('/api/admin/chats/closed');
    fechadas = r.chats || [];
  } catch (e) {
    fechadas = [];
  }
  renderDesk();
}

el('chatCloseBtn').addEventListener('click', function () {
  if (!desk.current) return;

  fecho.motivo = 'resolved';
  el('closeNote').value = '';

  qsa('[data-why]').forEach(function (b) {
    b.classList.toggle('on', b.getAttribute('data-why') === 'resolved');
  });

  el('closeBack').hidden = false;
});

qsa('[data-why]').forEach(function (b) {
  b.addEventListener('click', function () {
    fecho.motivo = b.getAttribute('data-why');
    qsa('[data-why]').forEach(function (x) { x.classList.remove('on'); });
    b.classList.add('on');
  });
});

el('closeCancel').addEventListener('click', function () {
  el('closeBack').hidden = true;
});

el('closeGo').addEventListener('click', async function () {
  if (!desk.current) return;

  /**
   * "Resolvido" exige dizer COMO.
   *
   * Um resolved sem resumo não serve de nada a quem abrir a
   * conversa daqui a um mês — nem ao agente que apanhar o mesmo
   * parceiro na semana seguinte.
   *
   * Os outros motivos não precisam: "não respondeu" já se explica.
   */
  var nota = el('closeNote').value.trim();

  if (fecho.motivo === 'resolved' && nota.length < 20) {
    el('closeNote').focus();
    return avisar('Say how it was resolved',
      'A sentence is enough. The next agent to get this partner will read ' +
      'it, and so will you in a month when you no longer remember.');
  }

  el('closeBack').hidden = true;
  el('closeGo').disabled = true;

  // Congela o cronómetro no valor final antes de qualquer pedido:
  // se a rede demorar, o número mostrado é o do momento em que
  // carregaste e não o da resposta do servidor.
  if (chatClock.inicio && !chatClock.fim) {
    chatClock.fim = Date.now();
    pararRelogio();
    pintarRelogio();
  }

  try {
    await deskFetch(rotaDaAba('close'), {
      chat_id: desk.current,
      reason: fecho.motivo,
      note: el('closeNote').value.trim() || null
    });
  } catch (e) {
    el('closeGo').disabled = false;
    return avisar('Could not close it', e.message);
  }

  el('closeGo').disabled = false;

  // Os trinta segundos arrancam depois de fechar, não antes: a
  // decisão já foi tomada e o slot já está livre.
  setTimeout(pedirEscolha, 400);

  desk.current = null;
  pararRelogio();
  pararRelogioResposta();
  pararPresenca();
  el('chatClock').hidden = true;
  el('chatOpen').classList.add('hidden');
  el('chatBlank').classList.remove('hidden');
  document.body.classList.remove('chat-open');

  await loadDesk();
  carregarFechadas();
});

// ============================================================
// ESCALAR
//
// Não é fechar. A conversa continua aberta e passa para outra
// pessoa. Fechar por não saber responder seria a pior saída: o
// parceiro fica sem resposta e o problema desaparece do relatório.
// ============================================================
el('chatEscalateBtn').addEventListener('click', function () {
  if (!desk.current) return;
  el('escNote').value = '';
  el('escBack').hidden = false;
  setTimeout(function () { el('escNote').focus(); }, 40);
});

el('escCancel').addEventListener('click', function () {
  el('escBack').hidden = true;
});

el('escGo').addEventListener('click', async function () {
  var nota = el('escNote').value.trim();

  if (!nota) {
    return avisar('Say what happened',
      'Escalating without context means whoever picks it up starts from ' +
      'nothing — and the partner explains everything twice.');
  }

  el('escGo').disabled = true;

  try {
    var r = await deskFetch('/api/admin/chat/escalate', {
      chat_id: desk.current,
      note: nota
    });

    el('escBack').hidden = true;

    await avisar('Escalated', r.back_to_queue
      ? 'No supervisor was free, so it went back to the queue. Somebody will ' +
        'pick it up.'
      : 'It is with a supervisor now. You are off this one.');

    desk.current = null;
    pararRelogio();
    el('chatOpen').classList.add('hidden');
    el('chatBlank').classList.remove('hidden');
    document.body.classList.remove('chat-open');

    await loadDesk();
  } catch (e) {
    avisar('Could not escalate', e.message);
  } finally {
    el('escGo').disabled = false;
  }
});


el('chatReleaseBtn').addEventListener('click', async function () {
  if (!desk.current) return;

  await deskFetch('/api/admin/chat/release', { chat_id: desk.current, close: false });
  desk.current = null;
  pararRelogio();
  el('chatClock').hidden = true;
  el('chatOpen').classList.add('hidden');
  el('chatBlank').classList.remove('hidden');
  await loadDesk();
});

el('chatUrgentBtn').addEventListener('click', async function () {
  var chat = desk.chats.find(function (c) { return c.chat_id === desk.current; });
  if (!chat) return;

  await deskFetch('/api/admin/chat/flag', { chat_id: desk.current, urgent: !chat.urgent });
  await loadDesk();
  el('chatUrgentBtn').textContent = chat.urgent ? 'Flag urgent' : 'Remove urgent';
});

/**
 * Ao serviço, com batida de dois em dois minutos.
 *
 * Sem a batida, a presença expira sozinha ao fim de três. É de
 * propósito: um separador esquecido aberto diria "online" a noite
 * inteira, e um parceiro escreveria à espera de resposta imediata.
 */
/**
 * Os estados de um agente.
 *
 * `takes` diz se chegam chats novos. Só o live e o active o fazem —
 * os outros são formas diferentes de estar ocupado, e distingui-las
 * é o que torna o relatório do dia útil: "quatro horas em break" e
 * "duas em break, duas em formação" são coisas diferentes.
 *
 * `auto` marca o que não se escolhe. O active entra quando se pega
 * um chat e sai quando se larga o último.
 */
var STATES = [
  /**
   * O Live e o Active NÃO se escolhem.
   *
   * São consequências: com ticket é Active, sem ticket é Live. Um
   * gatilho no Postgres trata disso sempre que uma conversa muda
   * de mãos.
   *
   * Aparecem no menu para se ver onde se está, mas não se clicam —
   * clicar em Live com três tickets abertos seria uma afirmação
   * falsa que o servidor recusaria na mesma.
   *
   * Para SAIR de serviço há os outros: break, lunch, offline.
   */
  { key: 'live', label: 'Live', color: '#16A34A', takes: true, auto: true,
    note: 'Ready, with nothing open. You land here when you close your last ticket.' },
  { key: 'active', label: 'Active', color: '#2563EB', takes: true, auto: true,
    note: 'You have tickets open. Close them and you go back to Live on your own.',
    // Quantos chats abertos, no rótulo. Um agente que veja 2/3 sabe
    // que ainda pode receber um; a 3/3 sabe porque parou de tocar.
    contagem: true },
  { key: 'escalating', label: 'Escalating', color: '#C2410C', takes: false,
    note: 'Working something out with a supervisor. No new chats reach you, ' +
      'and the ones you have stay with you.' },
  { key: 'follow-up', label: 'Follow-up', color: '#7C3AED', takes: false,
    note: 'Wrapping up. No new chats reach you, and the ones you have stay ' +
      'with you — use it in the last minutes of a shift so nothing starts ' +
      'that you cannot finish.' },
  { key: 'training', label: 'Training', color: '#0891B2', takes: false,
    note: 'In training. You still count as on shift.' },
  { key: 'admin', label: 'Admin', color: '#64748B', takes: false,
    note: 'Administrative work. No new chats.' },
  { key: 'break', label: 'Break', color: '#D97706', takes: false,
    note: 'Short break. The chats you already have still work, and you still ' +
      'count as being on shift.' },
  { key: 'lunch', label: 'Lunch', color: '#CA8A04', takes: false,
    note: 'Longer break. Counts separately from short breaks, which is what ' +
      'makes the day report useful for planning shifts.' },
  { key: 'offline', label: 'Offline', color: '#DC2626', takes: false, sair: true,
    // Sem nota: o estado diz-se sozinho. Mas há uma regra que
    // convém saber antes de tentar.
    note: 'You cannot go offline while you still have chats open.' }
];

// ============================================================
// AVATARES
//
// As iniciais são o valor por omissão e chegam. A fotografia é
// opcional, e quando existe ocupa o mesmo espaço — o desenho à
// volta não muda.
// ============================================================
var meuAvatar = null;

/**
 * O endereço público de um avatar.
 *
 * O balde é público de leitura, ao contrário dos documentos e dos
 * anexos. Assinar cada fotografia obrigaria a um pedido por imagem
 * e por minuto, e não protegeria nada que não seja já visível a
 * quem está na conversa.
 */
function avatarUrl(caminho) {
  if (!caminho) return null;
  return SUPABASE_URL + '/storage/v1/object/public/avatars/' + caminho;
}

/** As duas primeiras iniciais de um nome, para o avatar. */
function iniciais(nome) {
  return String(nome || '?').trim().split(/\s+/).slice(0, 2)
    .map(function (p) { return p[0]; }).join('').toUpperCase() || '?';
}

function estadoInfo(chave) {
  return STATES.find(function (s) { return s.key === chave; }) ||
    { key: chave, label: chave, color: '#94A3B8', takes: false, note: '' };
}

var STATE_NOTES = (function () {
  var m = { unknown: 'Checking your shift...' };
  STATES.forEach(function (s) { m[s.key] = s.note; });
  return m;
})();

// ============================================================
// O DROPDOWN
// ============================================================
function pintarDuty() {
  var info = estadoInfo(desk.state);
  var btn = el('dutyBtn');
  var nome = deskDisplayName || adminName();

  el('dutyName').textContent = nome;
  el('dutyAv').textContent = iniciais(nome);

  var url = avatarUrl(meuAvatar);
  var pic = el('dutyPic');

  if (url) {
    pic.src = url;
    pic.classList.remove('hidden');
    btn.classList.add('has-pic');
  } else {
    pic.classList.add('hidden');
    btn.classList.remove('has-pic');
  }
  /**
   * O tempo no estado atual, no próprio botão.
   *
   * Estava só na barra da direita e dentro do menu. A pergunta
   * "há quanto tempo estou assim" é frequente demais para exigir
   * um clique ou desviar o olhar para o outro lado do ecrã.
   */
  var nele = desk.state && desk.state !== 'unknown' && desk.state !== 'offline'
    ? duracao(segundosNoEstado())
    : null;

  var rotulo = info.label;

  if (info.contagem) {
    var meus = (desk.chats || []).filter(function (c) {
      return c.assigned_to === adminId() && c.status === 'open';
    }).length;
    rotulo += ' ' + meus + '/3';
  }

  el('dutyLabel').textContent = desk.state === 'unknown'
    ? 'Checking'
    : rotulo + (nele ? ' · ' + nele : '');

  btn.style.setProperty('--duty-color', info.color);
  btn.classList.toggle('taking', Boolean(info.takes));

  // Quem está autenticado e com que cargo, no topo do menu. Numa
  // equipa que partilha máquinas, é a primeira coisa a confirmar.
  var cabeca = '<div class="duty-who">' +
    '<b>' + escapeHtml(nomeAtual()) + '</b>' +
    '<span>' + escapeHtml(adminEmail()) + '</span>' +
    '<span class="duty-role' + (souSupervisor ? '' : ' agent') + '">' +
    escapeHtml(souSupervisor ? 'Supervisor' : 'Agent') + '</span>' +
    '</div>';

  /**
   * Entrar ao serviço, quando se está fora.
   *
   * O Live é automático e não se clica — mas quem está offline
   * precisa de uma porta de entrada. Este botão é essa porta, e só
   * aparece quando faz falta.
   */
  var entrar = (desk.state === 'offline' || desk.state === 'unknown')
    ? '<button class="duty-opt duty-in" data-duty-opt="live" type="button">' +
      '<span class="dot" style="background:#16A34A"></span>' +
      '<b>Go on duty</b></button><div class="duty-sep"></div>'
    : '';

  el('dutyMenu').innerHTML = cabeca + entrar + STATES.map(function (st) {
    // O active aparece mas não se clica: entra e sai sozinho.
    var nome = st.label;

    if (st.contagem) {
      var abertos = (desk.chats || []).filter(function (c) {
        return c.assigned_to === adminId() && c.status === 'open';
      }).length;
      nome += ' ' + abertos + '/3';
    }

    /**
     * O tempo só no estado ATUAL.
     *
     * Aparecia em todos, com o total do dia — e "Live 3h20" ao lado
     * de uma opção que não está escolhida lê-se como se estivesse
     * em Live há três horas. O total do dia já está na barra da
     * direita, que é onde faz sentido.
     */
    var agora = st.key === desk.state
      ? duracao(segundosNoEstado())
      : null;

    return '<button class="duty-opt' + (st.key === desk.state ? ' on' : '') +
      (st.auto ? ' auto' : '') + '" data-duty-opt="' + st.key + '" type="button"' +
      (st.auto ? ' disabled' : '') + '>' +
      '<span class="dot" style="background:' + st.color + '"></span>' +
      escapeHtml(nome) +
      (agora ? '<small>' + agora + '</small>' : '') +
      '</button>' +
      (st.key === 'admin' ? '<div class="duty-sep"></div>' : '');
  }).join('');

  // A fotografia, no fim do menu. Ali e não numa página de
  // definições: é onde a pessoa já está quando pensa em si própria.
  var url = avatarUrl(meuAvatar);

  el('dutyMenu').innerHTML += '<div class="av-row">' +
    (url
      ? '<img class="av-now" src="' + escapeHtml(url) + '" alt="">'
      : '<span class="av-now duty-av" style="border-radius:12px">' +
        escapeHtml(iniciais(nomeAtual())) + '</span>') +
    '<span class="av-txt">' +
      (url ? 'Your photo' : 'Using your initials') +
    '</span>' +
    '<button class="av-act" id="avPick" type="button">' +
      (url ? 'Change' : 'Add photo') + '</button>' +
    (url ? '<button class="av-act drop" id="avDrop" type="button">Remove</button>' : '') +
    '</div>';

  qsa('[data-duty-opt]').forEach(function (b) {
    b.addEventListener('click', function () {
      fecharDuty();
      pararEscolha();
      setDeskState(b.getAttribute('data-duty-opt'));
    });
  });

  var pick = document.getElementById('avPick');
  if (pick) pick.addEventListener('click', function (e) {
    e.stopPropagation();
    el('avatarFile').click();
  });

  var drop = document.getElementById('avDrop');
  if (drop) drop.addEventListener('click', function (e) {
    e.stopPropagation();
    guardarAvatar(null);
  });
}

function nomeAtual() {
  return deskDisplayName || adminName();
}

function adminEmail() {
  return (currentAdmin && currentAdmin.user && currentAdmin.user.email) || '';
}

/**
 * Envia a fotografia e guarda a referência.
 *
 * A primeira pasta do caminho é o uuid do agente: é isso que a
 * política do balde verifica antes de deixar escrever, e o que
 * impede alguém de substituir a fotografia de outra pessoa.
 */
el('avatarFile').addEventListener('change', async function () {
  var ficheiro = this.files && this.files[0];
  this.value = '';
  if (!ficheiro) return;

  if (ficheiro.size > 2 * 1024 * 1024) {
    return avisar('Too large', 'That image is over 2 MB. A profile photo does not ' +
      'need to be bigger — try one straight from your phone camera roll rather ' +
      'than an edited file.');
  }

  fecharDuty();

  try {
    var ext = (ficheiro.name.split('.').pop() || 'jpg').toLowerCase();
    // O tempo no nome força o browser a ir buscar a nova: sem isso,
    // trocar de fotografia mostrava a antiga até se limpar a cache.
    var caminho = adminId() + '/avatar-' + Date.now() + '.' + ext;

    var up = await client.storage.from('avatars').upload(caminho, ficheiro, {
      contentType: ficheiro.type || 'image/jpeg',
      upsert: true
    });

    if (up.error) throw new Error(up.error.message);

    await guardarAvatar(caminho);
  } catch (e) {
    avisar('Could not save the photo', e.message);
  }
});

async function guardarAvatar(caminho) {
  try {
    await deskFetch('/api/admin/avatar', { path: caminho });
    meuAvatar = caminho;
    pintarDuty();
  } catch (e) {
    avisar('Could not save', e.message);
  }
}

function abrirDuty() {
  el('dutyMenu').hidden = false;
  el('dutyBtn').setAttribute('aria-expanded', 'true');
}

function fecharDuty() {
  el('dutyMenu').hidden = true;
  el('dutyBtn').setAttribute('aria-expanded', 'false');
}

el('dutyBtn').addEventListener('click', function (e) {
  e.stopPropagation();
  if (el('dutyMenu').hidden) { pintarDuty(); abrirDuty(); }
  else fecharDuty();
});

document.addEventListener('click', function (e) {
  if (!el('dutyMenu').hidden && !e.target.closest('#duty')) fecharDuty();
});

// ============================================================
// O TEMPO DO DIA
//
// Quanto tempo em cada estado, hoje. O estado atual conta ao vivo,
// senão apareceria a zero até se mudar dele.
// ============================================================
var tempoDoDia = {};
var metricasDoDia = {};
var diaTimer = null;

/**
 * O tempo no estado atual vem do SERVIDOR.
 *
 * Havia aqui um estadoDesde = Date.now(), e meia dúzia de sítios a
 * reescrevê-lo. Um refresh punha-o a agora, e a contagem
 * recomeçava — o que se via, e o que estava mal.
 *
 * Mais grave do que o incómodo: o relógio do browser não é de
 * confiança. Um agente com a hora do computador errada por dez
 * minutos via números errados, e ninguém perceberia porquê.
 *
 * Agora guarda-se o que o servidor disse e quando o dissemos. O
 * browser só conta o tempo DESDE a resposta, que é o único
 * intervalo em que o relógio local é fiável.
 */
var estadoRef = { segundos: 0, medidoEm: Date.now() };

/** Há quantos segundos estou neste estado, segundo o servidor. */
function segundosNoEstado() {
  if (desk.state === 'unknown' || desk.state === 'offline') return 0;

  var desde = Math.round((Date.now() - estadoRef.medidoEm) / 1000);

  return Math.max(0, estadoRef.segundos + desde);
}

/**
 * O servidor deu um número novo.
 *
 * Chamado sempre que uma resposta traz state_seconds. A partir daí
 * a contagem parte desse valor, e não do que o browser calculou.
 */
function marcarEstadoDesde(segundos) {
  estadoRef = {
    segundos: Number(segundos) || 0,
    medidoEm: Date.now()
  };
}

/** Quem sou eu, e com que cargo. */
var meuCargo = 'agent';
var souSupervisor = false;

function duracao(seg) {
  var s = Math.max(0, Math.round(seg));
  var h = Math.floor(s / 3600);
  var m = Math.floor((s % 3600) / 60);

  if (h > 0) return h + 'h' + String(m).padStart(2, '0');
  if (m > 0) return m + 'm';
  return s + 's';
}

/**
 * Hoje, no fuso do agente.
 *
 * O current_date do Postgres é UTC. Às 23h45 no Recife já são
 * 02h45 em UTC, e o painel dizia que o dia tinha acabado — com os
 * tempos todos a zero enquanto o agente ainda estava a trabalhar.
 *
 * O browser sabe o fuso; o servidor não. Por isso é daqui que a
 * data tem de vir.
 */
function hojeLocal() {
  var d = new Date();
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

/**
 * Pergunta ao servidor há quanto tempo estou neste estado.
 *
 * Corre com a batida do ponto. Sem isto, o browser contaria
 * sozinho durante horas — e um computador que adormece perde a
 * conta sem dar por isso.
 */
/**
 * O trabalho de fundo ainda corre?
 *
 * Se o cron parar — a conta expira, o segredo muda, o serviço fica
 * em baixo — as rotinas param. E nada avisa: o painel continua a
 * funcionar, por isso ninguém repara até alguém notar que há três
 * dias que ninguém é avisado de nada.
 */
async function verificarTrabalhoDeFundo() {
  var aviso = el('tickWarn');
  if (!aviso || aviso.__missing) return;

  try {
    var h = await deskFetch('/api/admin/health');
    aviso.classList.toggle('on', h && h.healthy === false);
  } catch (e) {
    // Uma falha aqui não prova nada sobre o cron: pode ser a rede.
    // Não se avisa por uma chamada falhada.
  }
}

async function sincronizarEstado() {
  try {
    var r = await deskFetch('/api/admin/team');

    var meu = (r.team || []).find(function (t) {
      return t.user_id === adminId();
    });

    if (!meu) return;

    // O estado pode ter mudado do lado do servidor — uma escalada,
    // um chat que fechou. O ecrã acompanha.
    if (meu.state && meu.state !== desk.state) {
      desk.state = meu.state;
      document.body.setAttribute('data-duty', meu.state);
      el('dutyNote').textContent = STATE_NOTES[meu.state] || '';
    }

    marcarEstadoDesde(meu.state_seconds || 0);

    pintarDuty();
    pintarDia();
  } catch (e) {
    // Uma falha aqui não é grave: o browser continua a contar a
    // partir do último número bom.
    console.log('[desk] state sync skipped:', e.message);
  }
}

async function carregarDia() {
  try {
    // O offset em minutos face a UTC. O getTimezoneOffset devolve
    // +180 para UTC-3, por isso inverte-se o sinal.
    var offset = -new Date().getTimezoneOffset();

    var res = await deskFetch('/api/admin/my-day?day=' + hojeLocal() +
      '&offset=' + offset);
    // O servidor passou a devolver um objeto por estado, em vez de
    // uma lista: poupa um ciclo aqui e um agrupamento lá.
    tempoDoDia = res.states || {};
    metricasDoDia = res.metrics || {};
  } catch (e) {
    tempoDoDia = {};
    metricasDoDia = {};
  }
  pintarDia();
}

function pintarDia() {
  var caixa = el('dayBar');
  if (!caixa || caixa.__missing) return;

  /**
   * O estado atual conta desde a última resposta do servidor.
   *
   * O agent_day_states JÁ inclui o período a decorrer — soma o
   * tempo até now() para o período sem ended_at. Somar o
   * segundosNoEstado() por cima contava-o duas vezes, e a barra
   * mostrava o dobro do tempo no estado atual.
   *
   * O que se soma aqui é só o que passou DESDE essa resposta, para
   * o número não ficar parado entre atualizações.
   */
  var vivo = Object.assign({}, tempoDoDia);

  if (desk.state && desk.state !== 'unknown' && desk.state !== 'offline') {
    var desdeAResposta = Math.max(0,
      Math.round((Date.now() - estadoRef.medidoEm) / 1000));

    vivo[desk.state] = (vivo[desk.state] || 0) + desdeAResposta;
  }

  var m = metricasDoDia || {};
  var partes = [];

  /**
   * Os três estados que interessam sempre, mesmo a zero.
   *
   * Live, break e offline aparecem sempre: "zero minutos em break"
   * é uma informação, e escondê-la faria a barra mudar de tamanho
   * ao longo do dia. Os outros só aparecem quando houve tempo lá.
   */
  ['live', 'break', 'offline'].forEach(function (chave) {
    var st = estadoInfo(chave);
    partes.push(bloco(st.label, duracao(vivo[chave] || 0),
      chave === desk.state, st.color));
  });

  STATES.forEach(function (st) {
    if (['live', 'break', 'offline'].indexOf(st.key) !== -1) return;
    if (!vivo[st.key]) return;
    partes.push(bloco(st.label, duracao(vivo[st.key]),
      st.key === desk.state, st.color));
  });

  // O que aconteceu, não só quanto tempo passou.
  partes.push(bloco('Rang', m.rang || 0));
  partes.push(bloco('Answered', m.answered || 0));
  partes.push(bloco('Missed', m.missed || 0, false, null,
    m.missed > 0 ? 'warn' : ''));
  partes.push(bloco('Escalated', m.escalated || 0, false, null,
    m.escalated > 0 ? 'warn' : ''));

  partes.push(bloco('Avg answer',
    m.avg_answer_seconds != null ? m.avg_answer_seconds + 's' : '—'));

  // A taxa só ganha cor a partir de cinco chamadas. Uma perdida em
  // duas dá 50% e não quer dizer nada — pintar isso de vermelho às
  // nove da manhã é injusto e é ruído.
  var taxa = m.answer_rate;
  var corTaxa = '';

  if (taxa != null && (m.rang || 0) >= 5) {
    corTaxa = taxa >= 90 ? 'good' : (taxa >= 70 ? 'warn' : 'bad');
  }

  partes.push(bloco('Answer rate',
    taxa != null ? taxa + '%' : '—', false, null, corTaxa));

  caixa.innerHTML = partes.join('');
}

/** Um número da barra do dia. */
function bloco(rotulo, valor, agora, cor, classe) {
  return '<span class="db' + (agora ? ' now' : '') + '"' +
    (cor ? ' style="--duty-color:' + cor + ';color:' + cor + '"' : '') + '>' +
    (cor ? '<i style="background:' + cor + '"></i>' : '') +
    '<span class="db-k">' + escapeHtml(rotulo) + '</span>' +
    '<span class="db-v' + (classe ? ' ' + classe : '') + '">' +
    escapeHtml(valor) + '</span></span>';
}

function arrancarDia() {
  if (diaTimer) clearInterval(diaTimer);
  // De dez em dez segundos chega: os números são em minutos, e um
  // intervalo por segundo só gastaria bateria.
  diaTimer = setInterval(function () {
    pintarDia();
    // O botão também: sem isto o tempo lá ficava parado no valor
    // que tinha quando o estado mudou.
    pintarDuty();
  }, 10000);
}

// ============================================================
// OS TRINTA SEGUNDOS
//
// Ao fechar um chat, o agente tem meio minuto para dizer o que vai
// fazer a seguir. Sem isto, quem fechasse e fosse tratar de outra
// coisa aparecia disponível e recebia logo outro.
//
// Se não escolher, o sistema decide: active se ainda tem chats
// abertos, live se não tem.
// ============================================================
var escolha = { timer: null, left: 0 };

function pararEscolha() {
  if (escolha.timer) { clearInterval(escolha.timer); escolha.timer = null; }
  el('dutyCountdown').hidden = true;
}

function pedirEscolha() {
  // Em escalating não se pergunta nada: o agente disse que está a
  // resolver um caso, e sai disso quando quiser.
  if (desk.state === 'escalating') return;

  pararEscolha();
  escolha.left = 30;

  var abertos = function () {
    return (desk.chats || []).filter(function (c) {
      return c.assigned_to === adminId() && c.status === 'open';
    }).length;
  };

  el('dutyCountText').textContent = abertos()
    ? 'Choose your next status — otherwise Active'
    : 'Choose your next status — otherwise Live';

  el('dutyCountNum').textContent = escolha.left;
  el('dutyCountdown').hidden = false;

  escolha.timer = setInterval(function () {
    escolha.left -= 1;
    el('dutyCountNum').textContent = Math.max(0, escolha.left);

    if (escolha.left <= 0) {
      pararEscolha();
      setDeskState(abertos() ? 'active' : 'live', true);
    }
  }, 1000);
}

async function setDeskState(state, aRetomar, desdeQuando) {
  var previous = desk.state;

  /**
   * O servidor decide primeiro; o ecrã muda depois.
   *
   * Estava ao contrário: o painel punha-se no estado novo e só
   * depois perguntava. Quando a resposta era uma recusa — tentar
   * ficar offline com conversas abertas — o agente via-se offline
   * durante o segundo que a mensagem de erro demorava a aparecer.
   *
   * Um painel que mostra um estado que o servidor recusou é pior
   * do que um que demora um segundo a mudar.
   */
  try {
    await deskFetch('/api/admin/presence', {
      state: state,
      // O nome escolhido, não o email. O servidor faz upsert nesta
      // coluna, por isso mandar adminName() aqui apagava o nome
      // definido — a cada mudança de estado e a cada batida do ponto.
      display_name: deskDisplayName || adminName(),
      // O servidor guarda se foi escolha do agente ou decisão do
      // sistema. No relatório, "meia hora em break" e "meia hora
      // em break porque ninguém escolheu" não são a mesma coisa.
      automatic: Boolean(aRetomar)
    });
  } catch (e) {
    /**
     * A mudança foi recusada.
     *
     * O caso real é tentar ficar offline com conversas abertas: elas
     * ficariam com o nome de quem já não está lá, e não voltam à
     * fila sozinhas.
     *
     * Nada mudou no ecrã, por isso não há nada a repor.
     */
    var titulo = /open|conversation/i.test(e.message)
      ? 'You still have chats open'
      : 'Could not change your status';

    await avisar(titulo, e.message);
    return;
  }

  // A partir daqui o servidor já aceitou.
  desk.state = state;

  if (state !== 'offline') el('wentOffline').classList.add('hidden');

  // O tempo no estado anterior fica contado; o novo começa agora.
  // Só se reinicia o relógio se o estado MUDOU mesmo. Uma chamada
  // com o mesmo estado — a retomar depois de um refresh, por
  // exemplo — deixaria a contagem a zero.
  if (previous !== state) {
    if (previous && previous !== 'unknown' && previous !== 'offline') {
      tempoDoDia[previous] = (tempoDoDia[previous] || 0) +
        segundosNoEstado();
    }

    // A retomar depois de um refresh, o período começou quando o
    // servidor diz que começou — não agora. Sem isto a contagem
    // recomeçava do zero a cada atualização da página.
    marcarEstadoDesde(desdeQuando != null ? desdeQuando : 0);
  }

  pintarDuty();
  pintarDia();

  el('dutyNote').textContent = STATE_NOTES[state] || '';

  // O estado no <body>: é daqui que a barra do topo tira a cor, e
  // qualquer outra coisa que precise de saber sem perguntar.
  document.body.setAttribute('data-duty', state);

  /**
   * Pôr-se em Live é um clique, e um clique é o gesto que o browser
   * exige para libertar o áudio. Aproveitamo-lo: quem entra ao
   * serviço fica com o som pronto no mesmo instante, sem ter de
   * clicar noutro sítio qualquer primeiro.
   */
  if (state === 'live' || state === 'active') {
    unlockAudio();
    // Uma nota curta a confirmar que o som funciona. É a diferença
    // entre saber que está pronto e descobrir na primeira chamada
    // perdida que não estava.
    //
    // Ao retomar depois de um refresh não toca: não houve gesto do
    // utilizador, o browser recusaria, e um som sem se pedir nada
    // é irritante.
    if (audioReady && soundOn && !aRetomar) beep();
  } else {
    // Em pausa ou offline não há chamada a tocar. Se estava a
    // insistir, para agora.
    stopAlarm();
  }

  if (desk.heartbeat) { clearInterval(desk.heartbeat); desk.heartbeat = null; }

  // A batida mantém a presença viva sem mexer no estado: quem está
  // em pausa continua em pausa, não volta sozinho a live.
  if (state !== 'offline') {
    desk.heartbeat = setInterval(function () {
      // O nome vai também na batida: o servidor põe display_name em
      // todos os upserts, e um corpo vazio fá-lo cair no email.
      deskFetch('/api/admin/presence', {
        display_name: deskDisplayName || adminName()
      }).catch(function () {});

      /**
       * De dois em dois minutos, os números reais.
       *
       * A conta do dia não pode viver só na memória do browser: um
       * separador aberto desde manhã acumula erro, e um portátil que
       * adormeceu acumula muito mais.
       *
       * Isto traz também os segundos no estado atual, o que corrige
       * qualquer desvio que o relógio local tenha criado.
       */
      carregarDia();
      sincronizarEstado();
      verificarTrabalhoDeFundo();
    }, 120000);
  }

  await loadDesk();
}





// O aviso laranja leva ao separador e à conversa mais antiga.
el('deskAlert').addEventListener('click', function () {
  switchTab('chatTab');

  var oldest = desk.chats.filter(function (c) {
    return c.unread_for_admin > 0 && !c.assigned_to;
  })[0];

  if (oldest) openDeskChat(oldest.chat_id);
});

// Fechar o separador não deve deixar-te marcado como presente.
//
// Não uso sendBeacon: ele não leva cabeçalhos de autenticação, e a
// rota exige o token. A batida de dois em dois minutos resolve o
// resto — ao fim de três, a presença expira sozinha. É por isso que
// a expiração existe: nem sempre há oportunidade de dizer adeus.
window.addEventListener('beforeunload', function () {
  if (desk.heartbeat) clearInterval(desk.heartbeat);
});

/**
 * O aviso de chat é mais insistente do que o das reservas.
 *
 * Uma reserva nova é uma boa notícia que pode esperar cinco minutos.
 * Uma mensagem de parceiro é alguém a olhar para um ecrã à espera —
 * por isso o som repete-se de trinta em trinta segundos até alguém
 * abrir o separador.
 */
var chatAlert = null;

function chatWaitingAlert() {
  var fire = function () {
    var waiting = desk.chats.filter(function (c) {
      return c.unread_for_admin > 0 && !c.assigned_to;
    }).length;

    // Já não há ninguém à espera, ou o separador está aberto.
    if (!waiting || activeTab === 'chatTab' || ring.offer) {
      if (chatAlert) { clearInterval(chatAlert); chatAlert = null; }
      document.title = 'Airportlink operations';
      return;
    }

    beep();
    document.title = '(' + waiting + ') Partner waiting';
  };

  // Sem toast quando a janela de chamada está aberta: dois avisos
  // ao mesmo tempo para a mesma coisa é ruído.
  if (!ring.offer) toast('Partner chat', 'A partner is waiting for a reply.', 'chatTab');
  fire();

  if (!chatAlert) chatAlert = setInterval(fire, 30000);
}

// ============================================================
// O DIA DE CADA AGENTE
//
// Tempo em cada estado e o que aconteceu às chamadas. Não é para
// castigar: é para saber, ao fim de um mês, se há um turno onde as
// chamadas ficam por atender.
// ============================================================
var shift = { rows: [], days: 1 };

function hhmm(seconds) {
  var s = Math.max(0, Math.round(Number(seconds) || 0));
  var h = Math.floor(s / 3600);
  var m = Math.round((s % 3600) / 60);
  return h ? h + 'h ' + String(m).padStart(2, '0') + 'm' : m + 'm';
}

async function loadShifts() {
  el('shiftBody').innerHTML = '<tr><td colspan="11" class="loading-row">Loading...</td></tr>';

  try {
    var data = await deskFetch('/api/admin/agent-day?days=' + shift.days);
    shift.rows = data.rows || [];
    renderShifts();
  } catch (e) {
    el('shiftBody').innerHTML = '<tr><td colspan="11"><div class="no-results">' +
      escapeHtml(e.message) + '</div></td></tr>';
  }
}

function renderShifts() {
  var rows = shift.rows;

  var totalLive = rows.reduce(function (t, r) { return t + Number(r.live_seconds || 0); }, 0);
  var totalBreak = rows.reduce(function (t, r) { return t + Number(r.break_seconds || 0); }, 0);
  var answered = rows.reduce(function (t, r) { return t + Number(r.answered || 0); }, 0);
  var missed = rows.reduce(function (t, r) { return t + Number(r.missed || 0); }, 0);
  var passed = rows.reduce(function (t, r) { return t + Number(r.passed || 0); }, 0);
  var resolved = rows.reduce(function (t, r) { return t + Number(r.resolved || 0); }, 0);
  var people = new Set(rows.map(function (r) { return r.user_id; })).size;

  el('shLive').textContent = hhmm(totalLive);
  el('shLiveSub').textContent = people + ' agent' + (people === 1 ? '' : 's') +
    ' · ' + hhmm(totalBreak) + ' on break';

  el('shAnswered').textContent = answered;
  el('shAnsweredSub').textContent = (answered + missed + passed)
    ? Math.round(100 * answered / (answered + missed + passed)) + '% of chats that rang'
    : 'Nothing rang yet';

  el('shMissed').textContent = missed + passed;
  el('shMissedSub').textContent = missed + ' timed out · ' + passed + ' passed on';

  el('shResolved').textContent = resolved;
  el('shResolvedSub').textContent = 'Closed by an agent';

  if (!rows.length) {
    el('shiftBody').innerHTML = '<tr><td colspan="11"><div class="no-results">' +
      'Nobody has been at the desk in this period.</div></td></tr>';
    el('shiftNote').textContent = '';
    return;
  }

  el('shiftBody').innerHTML = rows.map(function (r) {
    var rang = Number(r.answered || 0) + Number(r.missed || 0) + Number(r.passed || 0);
    var rate = r.answer_rate_pct;

    return '<tr>' +
      '<td>' + escapeHtml(r.day) + '</td>' +
      '<td><strong>' + escapeHtml(r.agent_name || 'unknown') + '</strong></td>' +
      '<td class="num-cell">' + escapeHtml(hhmm(r.live_seconds)) + '</td>' +
      '<td class="num-cell">' + escapeHtml(hhmm(r.break_seconds)) + '</td>' +
      '<td class="num-cell">' + rang + '</td>' +
      '<td class="num-cell pos">' + Number(r.answered || 0) + '</td>' +
      '<td class="num-cell' + (Number(r.missed) ? ' neg' : '') + '">' + Number(r.missed || 0) + '</td>' +
      '<td class="num-cell">' + Number(r.passed || 0) + '</td>' +
      '<td class="num-cell">' + (r.avg_answer_seconds ? r.avg_answer_seconds + 's' : '—') + '</td>' +
      '<td class="num-cell pos">' + Number(r.resolved || 0) + '</td>' +
      '<td class="num-cell' + (rate !== null && rate < 70 ? ' neg' : '') + '">' +
      (rate === null || rate === undefined ? '—' : rate + '%') + '</td>' +
      '</tr>';
  }).join('');

  el('shiftNote').textContent = 'Answer rate below 70% usually means the shift was ' +
    'understaffed, not that someone was slow — check how many agents were live at the ' +
    'same time before drawing a conclusion.';
}

qsa('#shiftDays .fin-period').forEach(function (b) {
  b.addEventListener('click', function () {
    qsa('#shiftDays .fin-period').forEach(function (x) { x.classList.remove('active'); });
    b.classList.add('active');
    shift.days = Number(b.getAttribute('data-days'));
    loadShifts();
  });
});

el('shiftRefresh').addEventListener('click', loadShifts);

el('shiftCsv').addEventListener('click', function () {
  if (!shift.rows.length) return avisar('Heads up', 'Nothing to export.');

  downloadRows(shift.rows.map(function (r) {
    return {
      day: r.day,
      agent: r.agent_name || '',
      live_minutes: r.live_minutes,
      break_minutes: r.break_minutes,
      chats_rang: Number(r.answered || 0) + Number(r.missed || 0) + Number(r.passed || 0),
      answered: r.answered,
      missed: r.missed,
      passed: r.passed,
      avg_answer_seconds: r.avg_answer_seconds || '',
      resolved: r.resolved,
      answer_rate_pct: r.answer_rate_pct === null ? '' : r.answer_rate_pct
    };
  }), 'airportlink-agent-activity');
});

// ============================================================
// CHAMADA A ENTRAR
//
// Trinta segundos para atender. Se não atender, passa ao seguinte e
// fica registado — não para castigar, mas para saber ao fim de um
// mês se há um turno onde as chamadas ficam por atender.
// ============================================================
var RING_SECONDS = 30;
var ring = { offer: null, chat: null, timer: null, left: 0, alarm: null };

function showRing(offer) {
  // Já está a tocar esta, ou estou a olhar para a conversa.
  if (ring.offer && ring.offer.id === offer.id) return;

  var chat = desk.chats.find(function (c) { return c.chat_id === offer.chat_id; });
  if (!chat) return;

  ring.offer = offer;
  ring.chat = chat;

  el('ringWho').textContent = chat.trading_name || chat.legal_name || chat.email;
  el('ringWhere').textContent = [chat.country, chat.partner_status].filter(Boolean).join('  ·  ');
  el('ringMsg').textContent = chat.last_message_text || 'No message yet';
  el('ring').classList.remove('hidden');

  // Quanto falta de verdade, não trinta fixos: se o painel esteve
  // fechado, a oferta já pode ter dez segundos.
  var expires = new Date(offer.expires_at).getTime();
  ring.left = Math.max(1, Math.round((expires - Date.now()) / 1000));

  startAlarm();
  tickRing();

  if (ring.timer) clearInterval(ring.timer);
  ring.timer = setInterval(tickRing, 1000);
}

function tickRing() {
  el('ringCount').textContent = ring.left;
  el('ringBar').style.width = Math.max(0, (ring.left / RING_SECONDS) * 100) + '%';

  if (ring.left <= 0) {
    // O tempo acabou: passa ao seguinte sozinho.
    passRing(false);
    return;
  }

  ring.left -= 1;
}

function stopRing() {
  if (ring.timer) { clearInterval(ring.timer); ring.timer = null; }
  stopAlarm();
  ring.offer = null;
  ring.chat = null;
  el('ring').classList.add('hidden');
}

/**
 * O alarme repete até alguém decidir.
 *
 * Um som único perde-se se a pessoa estiver noutro separador. Aqui
 * há alguém à espera com um relógio a correr, e é a única coisa no
 * painel que justifica insistir.
 */
function startAlarm() {
  stopAlarm();
  ringTone();
  // De quatro em quatro: o toque dura quase um segundo, e mais
  // frequente do que isto sobrepõe-se a si próprio.
  ring.alarm = setInterval(ringTone, 4000);
  document.title = '\u260E Incoming chat';
}

function stopAlarm() {
  if (ring.alarm) { clearInterval(ring.alarm); ring.alarm = null; }
  document.title = 'Airportlink operations';
}

el('ringTake').addEventListener('click', async function () {
  var chatId = ring.offer && ring.offer.chat_id;
  if (!chatId) return;

  stopRing();
  switchTab('chatTab');

  /**
   * Atender é PEGAR, não só abrir.
   *
   * Antes isto só abria a conversa. A oferta ficava pendurada, os
   * trinta segundos corriam até ao fim, e o servidor registava
   * "não atendeu" a quem tinha carregado no botão.
   */
  await pegarConversa(chatId);
});

el('ringPass').addEventListener('click', function () { passRing(true); });

async function passRing(declined) {
  var chatId = ring.offer && ring.offer.chat_id;
  stopRing();
  if (!chatId) return;

  try {
    var r = await deskFetch('/api/admin/chat/pass', {
      chat_id: chatId, declined: declined === true
    });

    // Não atendeu por silêncio: o servidor põe offline. Dizê-lo é o
    // que impede alguém de passar uma hora sem perceber que parou
    // de receber chamadas.
    if (r && r.went_offline) {
      desk.state = 'offline';
      marcarEstadoDesde(0);
      pintarDuty();
      pintarDia();
      el('dutyNote').textContent = STATE_NOTES.offline;

      if (desk.heartbeat) { clearInterval(desk.heartbeat); desk.heartbeat = null; }

      // A contagem dos trinta segundos pós-fecho, se estivesse a
      // correr, deixa de fazer sentido: já não há decisão a tomar.
      pararEscolha();

      el('wentOffline').classList.remove('hidden');

      /**
       * O som toca aqui de propósito, mesmo estando offline.
       *
       * O podeTocar recusa em offline — e é essa a regra. Mas este
       * é o único momento em que o silêncio seria contra o agente:
       * ele acabou de perder uma chamada e a única forma de o saber
       * é olhar para um ecrã que não estava a ver.
       */
      forcarTom();
    }
  } catch (e) {
    console.error('pass:', e.message);
  }

  await loadDesk();
}

el('backOnline').addEventListener('click', function () {
  el('wentOffline').classList.add('hidden');
  setDeskState('live');
});

el('stayOffline').addEventListener('click', function () {
  el('wentOffline').classList.add('hidden');
});

/**
 * A janela NÃO fecha com Escape nem com um clique fora.
 *
 * É a única do painel assim, e de propósito: fechá-la sem
 * responder deixaria o agente offline a pensar que continua ao
 * serviço — que é exatamente a situação que ela existe para
 * evitar. Tem de haver uma escolha.
 */
el('wentOffline').addEventListener('click', function (e) {
  if (e.target === el('wentOffline')) {
    // Um clique fora chama a atenção para os botões em vez de
    // fechar. Sem reação nenhuma, parece que a página bloqueou.
    var caixa = el('wentOffline').querySelector('.still');
    if (!caixa) return;
    caixa.style.animation = 'none';
    void caixa.offsetWidth;
    caixa.style.animation = 'stillUp .28s cubic-bezier(.22,1.1,.36,1)';
  }
});

/**
 * A fila acompanha o que os OUTROS agentes fazem.
 *
 * Antes só reagia a duas coisas: uma oferta a tocar e uma mensagem
 * nova de parceiro. Não reagia a outro agente pegar ou fechar uma
 * conversa — e com dois agentes isso quebra:
 *
 *   A vê três conversas livres.
 *   B pega a segunda.
 *   A continua a vê-la livre; nada o avisou.
 *   A clica -> "Somebody else got there first".
 *
 * O erro estava tratado, mas a lista mentiu-lhe. É isso que corrói
 * a confiança na ferramenta.
 *
 * Agora escuta UPDATE nas duas tabelas de conversa, e as mensagens
 * dos três públicos e não só dos parceiros.
 */
function subscribeDesk() {
  if (desk.channel) return;

  desk.channel = client.channel('desk-live')

    // ---------- ofertas a tocar ----------
    .on('postgres_changes', {
      event: 'INSERT', schema: 'public', table: 'chat_offers'
    }, function (payload) {
      var offer = payload.new;

      // Só as minhas, e só as que ainda estão a tocar.
      if (offer.agent_id !== adminId()) return;
      if (offer.outcome !== 'ringing') return;

      pedirFila();
    })

    // ---------- mensagens de parceiro ----------
    .on('postgres_changes', {
      event: 'INSERT', schema: 'public', table: 'partner_messages'
    }, function (payload) {
      mensagemNova(payload.new, 'partner');
    })

    // ---------- mensagens de cliente e de agência ----------
    //
    // Estas nem existiam. Uma mensagem nova de um cliente não
    // aparecia até alguém recarregar a página — e as duas filas
    // novas ficavam paradas.
    .on('postgres_changes', {
      event: 'INSERT', schema: 'public', table: 'support_messages'
    }, function (payload) {
      var m = payload.new;
      mensagemNova({
        chat_id: m.chat_id,
        sender: m.sender_type,
        body: m.message,
        sender_name: m.sender_name,
        created_at: m.created_at,
        internal: m.internal
      }, 'user');
    })

    /**
     * Uma conversa mudou de mãos, fechou, ou ficou atrasada.
     *
     * É o que faltava. O assigned_to muda quando alguém pega; o
     * status quando alguém fecha; o warn_level de minuto a minuto
     * quando o support_tick marca uma espera longa.
     *
     * Nenhuma dessas coisas chegava ao ecrã.
     */
    .on('postgres_changes', {
      event: 'UPDATE', schema: 'public', table: 'partner_chats'
    }, function () {
      pedirFila();
    })

    .on('postgres_changes', {
      event: 'UPDATE', schema: 'public', table: 'support_chats'
    }, function () {
      pedirFila();
    })

    /**
     * Um agente entrou, saiu, ou mudou de estado.
     *
     * A barra da equipa mostrava quem estava ao serviço no momento
     * em que a página abriu, e mais nada.
     */
    .on('postgres_changes', {
      event: '*', schema: 'public', table: 'support_presence'
    }, function (payload) {
      // Se sou eu, o estado pode ter mudado do lado do servidor —
      // uma escalada, um chat que fechou. O ecrã acompanha.
      if (payload.new && payload.new.user_id === adminId()) {
        sincronizarEstado();
      }
    })

    .subscribe();
}

/**
 * Uma mensagem nova, venha de que fila vier.
 *
 * Os parceiros e os clientes guardam as mensagens em tabelas
 * diferentes com nomes de coluna diferentes. Aqui já chegam
 * normalizadas — o resto do painel não precisa de saber a
 * diferença.
 */
function mensagemNova(m, deQuem) {
  // As notas internas entre agentes não avisam ninguém: já estão
  // no ecrã de quem as escreveu.
  if (m.internal) return;
  if (m.sender !== deQuem) return;

  // Se é a conversa aberta, entra na janela.
  if (m.chat_id === desk.current) {
    desk.messages.push(m);
    renderThread();
    pedirFila();
    return;
  }

  pedirFila();

  /**
   * Um aviso de cada vez.
   *
   * Se a janela de chamada está a tocar, ela já diz tudo o que
   * este aviso diria — e com um contador que este não tem.
   *
   * O atraso existe porque a mensagem chega pelo tempo real ANTES
   * de a fila trazer a oferta: sem esperar, o ring.offer ainda
   * está vazio e os dois avisos aparecem.
   */
  setTimeout(function () {
    if (ring.offer) return;
    chatWaitingAlert();
  }, 1200);
}

/**
 * Pede a fila, mas no máximo uma vez por segundo.
 *
 * Sem isto, dez mensagens a chegar juntas — o que acontece quando
 * um agente responde a três conversas seguidas — davam dez idas ao
 * servidor a dois segundos cada. O painel engasgava-se.
 *
 * O primeiro pedido parte já; os que chegarem no segundo seguinte
 * juntam-se num só.
 */
var filaPedida = 0;
var filaAgendada = null;

/**
 * Uma rede de segurança, de dez em dez segundos.
 *
 * O tempo real do Supabase é fiável mas não é garantido: uma
 * ligação que cai e volta pode perder eventos, e o painel não dá
 * por isso — fica a mostrar uma fila que já não existe.
 *
 * Dez segundos é o compromisso: um agente não repara na diferença,
 * e são só seis pedidos por minuto.
 *
 * Só corre quando o separador está VISÍVEL. Um painel em segundo
 * plano não precisa de estar atualizado, e os browsers travam os
 * temporizadores de qualquer forma.
 */
function arrancarFilaPeriodica() {
  if (desk.filaTimer) return;

  desk.filaTimer = setInterval(function () {
    if (document.hidden) return;
    if (activeTab !== 'chatTab') return;

    loadDesk();
  }, 10000);
}

function pedirFila() {
  var agora = Date.now();

  if (agora - filaPedida > 1000) {
    filaPedida = agora;
    loadDesk();
    return;
  }

  if (filaAgendada) return;

  filaAgendada = setTimeout(function () {
    filaAgendada = null;
    filaPedida = Date.now();
    loadDesk();
  }, 1000);
}

// ============================================================
// QUEM VAI BUSCAR O CLIENTE
//
// O email com os dados do motorista sai sozinho na véspera. Este
// bloco existe para os casos em que não deve sair como está: sem
// motorista, ou com um arranjado à mão fora do sistema.
// ============================================================
function renderDriverBox(b) {
  var box = el('driverBox');

  var pickup = new Date(b.booking_date + 'T' + (b.booking_time || '00:00'));
  var hours = (pickup.getTime() - Date.now()) / 36e5;

  // Só aparece perto da viagem. Faltando duas semanas, decidir quem
  // conduz é cedo e o bloco só ocupava espaço.
  var relevant = isFinite(hours) && hours > -24 && hours < 96 && b.status !== 'cancelled';
  box.classList.toggle('hidden', !relevant);
  if (!relevant) return;

  el('mdName').value = b.manual_driver_name || '';
  el('mdPhone').value = b.manual_driver_phone || '';
  el('mdVehicle').value = b.manual_vehicle || '';
  el('mdPlate').value = b.manual_vehicle_plate || '';
  el('driverMsg').style.display = 'none';

  var state = el('driverState');
  state.className = 'note';

  if (b.driver_details_sent_at) {
    state.className = 'note ok';
    state.textContent = 'The passenger already has the driver details, sent ' +
      formatTime(b.driver_details_sent_at) + '. Sending again replaces what they know.';
  } else if (b.driver_email_hold) {
    state.className = 'note warn';
    state.textContent = 'The email is on hold' +
      (b.driver_email_hold_reason ? ' — ' + b.driver_email_hold_reason : '') +
      '. Nothing goes out until you send it or save a driver here.';
  } else if (b.manual_driver_name) {
    state.textContent = 'A driver was added by hand: ' + b.manual_driver_name +
      '. These details go out the day before, ahead of anything the partner has.';
  } else if (b.assigned_partner_id) {
    state.textContent = 'A partner took this ride, so the email uses their driver. ' +
      'Fill this in only if you need to override that.';
  } else {
    state.className = 'note warn';
    state.textContent = 'Nobody has taken this ride. Unless a partner does, or you add ' +
      'a driver here, the passenger gets nothing the day before.';
  }

  el('mdHoldBtn').textContent = b.driver_email_hold ? 'Release the hold' : 'Hold the email';
}

async function rideDriver(action, extra) {
  if (!activeBooking) return;

  var box = el('driverMsg');
  box.style.display = 'none';

  var buttons = [el('mdSaveBtn'), el('mdSendBtn'), el('mdHoldBtn')];
  buttons.forEach(function (x) { x.disabled = true; });

  try {
    var res = await fetch(RENDER_URL + '/api/admin/ride-driver', {
      method: 'POST',
      headers: await authHeaders(),
      body: JSON.stringify(Object.assign({ booking_id: activeBooking.id, action: action }, extra || {}))
    });

    var result = await res.json();
    if (!res.ok || result.error) throw new Error(result.error || ('HTTP ' + res.status));

    box.style.background = '#052e22';
    box.style.color = '#6ee7b7';
    box.style.border = '1px solid #14532d';
    box.textContent = {
      manual: 'Driver saved. These details go to the passenger the day before.',
      send: 'Sent. The passenger now has the driver name and phone.',
      hold: 'Held. Nothing goes out until you release it.',
      release: 'Released. The email goes out the day before as usual.'
    }[action] || 'Done.';
    box.style.display = 'block';

    await loadBookings();
    activeBooking = allBookings.find(function (x) {
      return String(x.id) === String(activeBooking.id);
    }) || activeBooking;
    renderDriverBox(activeBooking);
  } catch (e) {
    box.style.background = '#7f1d1d';
    box.style.color = '#fecaca';
    box.style.border = '1px solid #991b1b';
    box.textContent = e.message;
    box.style.display = 'block';
  } finally {
    buttons.forEach(function (x) { x.disabled = false; });
  }
}

el('mdSaveBtn').addEventListener('click', function () {
  var name = el('mdName').value.trim();
  var phone = el('mdPhone').value.trim();

  if (!name || !phone) {
    return avisar('Heads up', 'A name and a phone number are the minimum.\n\n' +
      'The passenger calls that number if they cannot find the driver.');
  }

  rideDriver('manual', {
    driver: {
      name: name,
      phone: phone,
      vehicle: el('mdVehicle').value.trim(),
      plate: el('mdPlate').value.trim()
    }
  });
});

el('mdSendBtn').addEventListener('click', async function () {
  if (activeBooking && activeBooking.driver_details_sent_at) {
    if (!await perguntar('Send again', 'The passenger already had the details.\n\n' +
        'Send again with what is on file now?')) return;
  }
  rideDriver('send');
});

el('mdHoldBtn').addEventListener('click', async function () {
  if (activeBooking && activeBooking.driver_email_hold) {
    return rideDriver('release');
  }

  var why = await pedirTexto('Hold this one',
    'Why hold this one?\n\nOnly you see this. It shows here so you remember why.',
    '', 'Hold');
  if (why === null) return;

  rideDriver('hold', { reason: why || null });
});

// ============================================================
// CONTACTS
// ============================================================
async function loadContacts() {
  var tbody = el('contactsList');
  tbody.innerHTML = '<tr><td colspan="6" class="loading-row">Loading...</td></tr>';

  /**
   * Só clientes.
   *
   * A contacts guarda toda a gente com conta: clientes, parceiros
   * de motoristas, agências e os próprios agentes — o registo de
   * um parceiro cria lá uma linha para o email e o nome.
   *
   * Misturá-los nesta lista fazia "Accounts" mostrar quatro
   * públicos diferentes sem os distinguir. As outras tabelas têm
   * separador próprio.
   */
  var q = client.from('contacts')
    .select('id, display_id, full_name, email, phone_number, is_admin, created_at')
    .eq('is_admin', false)
    .order('created_at', { ascending: false });

  if (contactFilters.search) {
    q = q.or('full_name.ilike.%' + contactFilters.search + '%,email.ilike.%' + contactFilters.search + '%');
  }
  if (contactFilters.searchId) {
    q = q.eq('display_id', parseInt(contactFilters.searchId, 10) || contactFilters.searchId);
  }

  /**
   * Os motoristas e as agências saem daqui.
   *
   * O is_admin acima tira os agentes, mas um parceiro de
   * motoristas também tem linha na contacts — o registo dele
   * cria-a — e o id é o mesmo nas duas tabelas.
   *
   * Filtra-se depois de ler, e não com um "not in" na consulta,
   * porque o Supabase não deixa correlacionar tabelas assim a
   * partir do browser. Com alguns milhares de contas isto é
   * instantâneo; se um dia forem centenas de milhares, passa a
   * ser uma vista no Postgres.
   */
  var res = await q;
  if (res.error) {
    tbody.innerHTML = '<tr><td colspan="6" class="error-row">' + escapeHtml(res.error.message) + '</td></tr>';
    return;
  }

  var outros = await Promise.all([
    client.from('driver_partners').select('id'),
    client.from('travel_agents').select('id')
  ]);

  var excluir = {};
  outros.forEach(function (r) {
    (r.data || []).forEach(function (x) { excluir[x.id] = true; });
  });

  contacts = (res.data || []).filter(function (c) { return !excluir[c.id]; });
  contactPage = 1;
  renderContacts(); renderContactStats(); renderContactPagination();
}

function renderContacts() {
  var tbody = el('contactsList');
  var start = (contactPage - 1) * contactPerPage;
  var page = contacts.slice(start, start + contactPerPage);

  if (!page.length) {
    tbody.innerHTML = '<tr><td colspan="6"><div class="no-results">No accounts found</div></td></tr>';
    return;
  }

  tbody.innerHTML = page.map(function (c) {
    return '<tr>' +
      '<td><strong>' + escapeHtml(c.display_id || String(c.id || '').slice(0, 8)) + '</strong></td>' +
      '<td><strong>' + escapeHtml(c.full_name || 'N/A') + '</strong></td>' +
      '<td>' + escapeHtml(c.email || 'N/A') + '</td>' +
      '<td>' + escapeHtml(c.phone_number || '-') + '</td>' +
      '<td><span class="status ' + (c.is_admin ? 'completed' : 'pending') + '">' + (c.is_admin ? 'Yes' : 'No') + '</span></td>' +
      '<td><button class="btn btn-small" data-view-account="' + escapeHtml(c.email || '') + '">View</button></td></tr>';
  }).join('');

  qsa('[data-view-account]').forEach(function (b) {
    b.addEventListener('click', function () { viewAccount(b.getAttribute('data-view-account')); });
  });
  reportHeight();
}

function renderContactPagination() {
  var p = el('contactsPagination');
  var totalPages = Math.ceil(contacts.length / contactPerPage);
  if (totalPages <= 1) { p.innerHTML = ''; return; }

  var html = '<button class="pagination-btn" id="contactsPrevBtn">Prev</button>';
  for (var i = 1; i <= totalPages; i++) {
    if (i === contactPage) html += '<button class="pagination-btn active">' + i + '</button>';
    else if (i === 1 || i === totalPages || (i >= contactPage - 2 && i <= contactPage + 2))
      html += '<button class="pagination-btn contact-page-btn" data-page="' + i + '">' + i + '</button>';
  }
  html += '<button class="pagination-btn" id="contactsNextBtn">Next</button>' +
          '<span class="pagination-info">Page ' + contactPage + ' of ' + totalPages + '</span>';
  p.innerHTML = html;

  el('contactsPrevBtn').addEventListener('click', function () { changeContactPage(contactPage - 1); });
  el('contactsNextBtn').addEventListener('click', function () { changeContactPage(contactPage + 1); });
  qsa('.contact-page-btn').forEach(function (b) {
    b.addEventListener('click', function () { changeContactPage(Number(b.getAttribute('data-page'))); });
  });
}

function changeContactPage(page) {
  var totalPages = Math.ceil(contacts.length / contactPerPage);
  if (page < 1 || page > totalPages) return;
  contactPage = page;
  renderContacts(); renderContactPagination();
}

async function renderContactStats() {
  var res = await client.from('bookings').select('email');
  var withBookings = new Set((res.data || []).map(function (b) { return b.email; }).filter(Boolean));
  el('totalContacts').textContent = contacts.length;
  el('adminContacts').textContent = contacts.filter(function (c) { return c.is_admin; }).length;
  el('contactsWithBookings').textContent = contacts.filter(function (c) { return withBookings.has(c.email); }).length;
  el('selectedContactBookings').textContent = selectedContactBookings.length;
}

async function viewAccount(email) {
  var contact = contacts.find(function (c) { return c.email === email; });
  if (!contact) return;

  el('accountDetailsName').textContent = contact.full_name || 'N/A';
  el('accountDetailsEmail').textContent = contact.email || '';
  el('accountDetailsModal').classList.remove('hidden');

  qsa('.modal-tab').forEach(function (t) { t.classList.remove('active'); });
  qsa('.modal-tab-content').forEach(function (c) { c.classList.remove('active'); });
  document.querySelector('[data-tab="bookingsTabModal"]').classList.add('active');
  el('bookingsTabModal').classList.add('active');

  await loadAccountBookings(contact.email);
  await loadAccountChats(contact.email);
}

async function loadAccountBookings(email) {
  var tbody = el('accountBookingsList');
  tbody.innerHTML = '<tr><td colspan="6" class="loading-row">Loading...</td></tr>';

  var res = await client.from('bookings').select(bookingSelect)
    .eq('email', email).order('booking_date', { ascending: false });

  if (res.error) {
    tbody.innerHTML = '<tr><td colspan="6" class="error-row">' + escapeHtml(res.error.message) + '</td></tr>';
    return;
  }

  selectedContactBookings = res.data || [];
  el('accountBookingsCount').textContent = selectedContactBookings.length;
  el('selectedContactBookings').textContent = selectedContactBookings.length;

  if (!selectedContactBookings.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="no-results">No bookings</td></tr>';
    return;
  }

  tbody.innerHTML = selectedContactBookings.map(function (b) {
    return '<tr><td><strong>' + escapeHtml(bookingRef(b)) + '</strong></td>' +
      '<td>' + escapeHtml(b.pickup || 'N/A') + ' &rarr; ' + escapeHtml(b.dropoff || 'N/A') + '</td>' +
      '<td>' + escapeHtml(bookingWhen(b)) + '</td>' +
      '<td>' + escapeHtml(money(b.currency, b.price)) + '</td>' +
      '<td><span class="status ' + escapeHtml(b.status || 'pending') + '">' + escapeHtml(b.status || 'pending') + '</span></td>' +
      '<td>' + (b.receipt_url ? '<a class="receipt-link" href="' + escapeHtml(b.receipt_url) + '" target="_blank" rel="noopener">Open</a>' : 'N/A') + '</td></tr>';
  }).join('');
}

async function loadAccountChats(email) {
  var tbody = el('accountChatsList');
  tbody.innerHTML = '<tr><td colspan="5" class="loading-row">Loading...</td></tr>';

  var res = await client.from('support_chats').select('*')
    .eq('email', email).order('updated_at', { ascending: false });

  if (res.error) {
    tbody.innerHTML = '<tr><td colspan="5" class="error-row">' + escapeHtml(res.error.message) + '</td></tr>';
    return;
  }

  selectedContactChats = res.data || [];
  el('accountChatsCount').textContent = selectedContactChats.length;

  if (!selectedContactChats.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="no-results">No conversations</td></tr>';
    return;
  }

  await Promise.all(selectedContactChats.map(async function (c) {
    var last = await client.from('support_messages').select('message, sender_type')
      .eq('chat_id', c.id).order('created_at', { ascending: false }).limit(1).maybeSingle();
    c.last_message = last.data ? last.data.message : '';
    c.last_sender = last.data ? last.data.sender_type : '';
  }));

  tbody.innerHTML = selectedContactChats.map(function (c) {
    return '<tr><td><strong>' + escapeHtml(c.ticket_number || String(c.id).slice(0, 8)) + '</strong></td>' +
      '<td>' + escapeHtml(c.subject || '-') + '</td>' +
      '<td><span class="status ' + escapeHtml(c.status) + '">' + escapeHtml(c.status) + '</span></td>' +
      '<td style="max-width:260px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' +
        (c.last_sender === 'admin' ? 'Support: ' : '') + escapeHtml(c.last_message || '-') + '</td>' +
      '<td>' + escapeHtml(formatTime(c.updated_at)) + '</td></tr>';
  }).join('');
}

// ============================================================
// SUPPORT
// ============================================================
async function loadConversations() {
  var box = el('convListScroll');
  box.innerHTML = '<div class="loading-row">Loading...</div>';

  var q = client.from('support_chats').select('*').order('updated_at', { ascending: false });
  if (convFilters.status) q = q.eq('status', convFilters.status);
  if (convFilters.subject) q = q.eq('subject_type', convFilters.subject);

  var res = await q;
  if (res.error) { box.innerHTML = '<div class="error-row">' + escapeHtml(res.error.message) + '</div>'; return; }

  var list = res.data || [];
  if (convFilters.search) {
    var s = convFilters.search.toLowerCase();
    list = list.filter(function (c) {
      return (c.ticket_number || '').toLowerCase().indexOf(s) !== -1 ||
             (c.email || '').toLowerCase().indexOf(s) !== -1 ||
             (c.subject || '').toLowerCase().indexOf(s) !== -1 ||
             (c.full_name || '').toLowerCase().indexOf(s) !== -1;
    });
  }

  await Promise.all(list.map(async function (c) {
    var last = await client.from('support_messages').select('message, sender_type')
      .eq('chat_id', c.id).order('created_at', { ascending: false }).limit(1).maybeSingle();
    c.last_message = last.data ? last.data.message : '';
    c.last_sender = last.data ? last.data.sender_type : '';
  }));

  conversations = list;
  renderConversationList(); renderConvStats();
}

function renderConversationList() {
  var box = el('convListScroll');
  if (!conversations.length) { box.innerHTML = '<div class="no-results">No conversations</div>'; return; }

  box.innerHTML = conversations.map(function (c) {
    return '<div class="conv-item ' + (String(c.id) === String(activeConvId) ? 'active' : '') + '" data-id="' + escapeHtml(c.id) + '">' +
      '<div class="conv-item-top"><div class="conv-item-subject">' + escapeHtml(c.subject || '-') + '</div>' +
      '<span class="status ' + escapeHtml(c.status) + '">' + escapeHtml(c.status) + '</span></div>' +
      '<div class="conv-item-email"><strong>' + escapeHtml(c.ticket_number || 'No ticket') + '</strong>' +
      (c.email ? ' - ' + escapeHtml(c.email) : '') + '</div>' +
      '<div class="conv-item-snippet">' + (c.last_sender === 'admin' ? 'You: ' : '') + escapeHtml(c.last_message || 'No messages') + '</div>' +
      '<div><span class="conv-item-time">' + escapeHtml(formatTime(c.updated_at)) + '</span></div></div>';
  }).join('');

  qsa('.conv-item').forEach(function (e) {
    e.addEventListener('click', function () { selectConversation(e.getAttribute('data-id')); });
  });
  reportHeight();
}

function renderConvStats() {
  el('pendingConvCount').textContent = conversations.filter(function (c) { return c.status === 'pending'; }).length;
  el('openConvCount').textContent = conversations.filter(function (c) { return c.status === 'open'; }).length;
  el('resolvedConvCount').textContent = conversations.filter(function (c) { return c.status === 'resolved'; }).length;
  el('totalConvCount').textContent = conversations.length;
}

async function selectConversation(id) {
  activeConvId = id;
  renderedAdminMsgIds = new Set();
  showConvNote('');
  renderConversationList();

  var conv = conversations.find(function (c) { return String(c.id) === String(id); });
  if (!conv) return;

  el('convThreadEmpty').classList.add('hidden');
  el('convThreadActive').classList.remove('hidden');
  el('convThreadActive').style.display = 'flex';
  el('convSubject').textContent = conv.subject || '-';
  el('convTicketNumber').textContent = 'Ticket: ' + (conv.ticket_number || 'Not assigned');
  el('convCustomerInfo').textContent = (conv.full_name || 'Unknown') + ' - ' + (conv.email || '');
  updateStatusUI(conv.status);
  el('convMessages').innerHTML = '';

  var res = await client.from('support_messages').select('*')
    .eq('chat_id', id).order('created_at', { ascending: true });

  if (res.error) console.error('load messages error:', res.error);
  else if (res.data) {
    for (var i = 0; i < res.data.length; i++) await appendAdminMsgBubble(res.data[i]);
  }

  subscribeToActiveConv(id);
  reportHeight();
}

function updateStatusUI(status) {
  var badge = el('convStatusBadge');
  badge.textContent = status === 'pending' ? 'Pending' : (status === 'resolved' ? 'Resolved' : 'Open');
  badge.className = 'status ' + status;
  el('convToggleStatusBtn').textContent = status === 'resolved' ? 'Reopen conversation' : 'Mark as resolved';

  var blocked = status === 'resolved';
  el('convReplyInput').disabled = blocked;
  el('convSendBtn').disabled = blocked;
  el('adminAttachFileBtn').disabled = blocked;
  if (blocked) setAdminFile(null);
}

async function appendAdminMsgBubble(msg) {
  if (renderedAdminMsgIds.has(msg.id)) return;
  renderedAdminMsgIds.add(msg.id);

  var isAdmin = msg.sender_type === 'admin';
  var wrap = document.createElement('div');
  wrap.className = 'conv-msg ' + (isAdmin ? 'admin' : 'customer');
  wrap.setAttribute('data-msg-id', msg.id);
  wrap.innerHTML = escapeHtml(msg.message) +
    '<div class="conv-msg-meta">' + escapeHtml(isAdmin ? 'Support team' : (msg.sender_name || 'Customer')) +
    ' - ' + escapeHtml(formatTime(msg.created_at)) + '</div>';

  el('convMessages').appendChild(wrap);
  el('convMessages').scrollTop = el('convMessages').scrollHeight;

  await refreshAttachments(msg.id);
}

function subscribeToActiveConv(id) {
  if (adminMessagesChannel) { client.removeChannel(adminMessagesChannel); adminMessagesChannel = null; }
  adminMessagesChannel = client.channel('admin_conv_' + id)
    .on('postgres_changes', {
      event: 'INSERT', schema: 'public', table: 'support_messages', filter: 'chat_id=eq.' + id
    }, async function (payload) {
      await appendAdminMsgBubble(payload.new);
      setTimeout(function () { refreshAttachments(payload.new.id); }, 1500);
      setTimeout(function () { refreshAttachments(payload.new.id); }, 4000);

      var conv = conversations.find(function (c) { return String(c.id) === String(id); });
      if (conv) {
        conv.last_message = payload.new.message;
        conv.last_sender = payload.new.sender_type;
        conv.updated_at = payload.new.created_at;
        conversations.sort(function (a, b) { return new Date(b.updated_at) - new Date(a.updated_at); });
        renderConversationList();
      }
    }).subscribe();
}

function subscribeToAllConversations() {
  if (adminChatsChannel) { client.removeChannel(adminChatsChannel); adminChatsChannel = null; }
  adminChatsChannel = client.channel('admin_support_chats')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'support_chats' }, function (payload) {
      if (payload.eventType === 'DELETE') {
        conversations = conversations.filter(function (c) { return c.id !== payload.old.id; });
        renderConversationList(); renderConvStats();
        return;
      }
      var row = payload.new;
      var idx = conversations.findIndex(function (c) { return c.id === row.id; });
      if (idx >= 0) conversations[idx] = Object.assign({}, conversations[idx], row);
      else conversations.unshift(Object.assign({ last_message: '', last_sender: '' }, row));
      conversations.sort(function (a, b) { return new Date(b.updated_at) - new Date(a.updated_at); });
      renderConversationList(); renderConvStats();
      if (String(row.id) === String(activeConvId)) updateStatusUI(row.status);
    }).subscribe();
}

/** O ficheiro sobe ANTES de a mensagem ser criada: se falhar, não
 *  fica uma mensagem órfã e o ficheiro continua selecionado. */
async function sendAdminReply() {
  var text = el('convReplyInput').value.trim();
  var fileToSend = adminSelectedFile;
  if (!text && !fileToSend) return;
  if (!activeConvId || !currentAdmin) return;

  var conv = conversations.find(function (c) { return String(c.id) === String(activeConvId); });
  if (!conv || conv.status === 'resolved') return;

  el('convSendBtn').disabled = true;
  el('adminAttachFileBtn').disabled = true;
  showConvNote('');

  try {
    var uploadedPath = null;

    if (fileToSend) {
      var ext = (fileToSend.name.split('.').pop() || 'bin').toLowerCase();
      var rand = Math.random().toString(36).slice(2, 10);
      // Primeira pasta = id da conversa, para o cliente também poder ler.
      uploadedPath = activeConvId + '/' + Date.now() + '-' + rand + '.' + ext;

      var up = await client.storage.from(STORAGE_BUCKET).upload(uploadedPath, fileToSend, {
        contentType: fileToSend.type || 'application/octet-stream'
      });

      if (up.error) {
        console.error('upload error:', up.error);
        showConvNote('The file could not be uploaded, so nothing was sent: ' + up.error.message, true);
        return;
      }
    }

    var msgRes = await client.from('support_messages').insert({
      chat_id: activeConvId,
      sender_type: 'admin',
      sender_name: 'Airportlink Support',
      message: text || fileToSend.name
    }).select().single();

    if (msgRes.error) {
      console.error('send message error:', msgRes.error);
      showConvNote('Could not send the reply: ' + msgRes.error.message, true);
      return;
    }

    if (uploadedPath) {
      var ins = await client.from('support_attachments').insert({
        chat_id: activeConvId,
        message_id: msgRes.data.id,
        file_url: '',
        file_path: uploadedPath,
        file_name: fileToSend.name,
        file_type: fileToSend.type || 'application/octet-stream',
        file_size: fileToSend.size,
        sender_type: 'admin'
      });
      if (ins.error) {
        console.error('attachment insert error:', ins.error);
        showConvNote('Uploaded but not attached: ' + ins.error.message +
          ' (code ' + (ins.error.code || 'n/a') + ')', true);
      }
    }

    if (conv.status === 'pending') {
      var st = await client.from('support_chats')
        .update({ status: 'open', updated_at: new Date().toISOString() }).eq('id', activeConvId);
      if (!st.error) conv.status = 'open';
    }

    conv.last_message = text || fileToSend.name;
    conv.last_sender = 'admin';
    conv.updated_at = msgRes.data.created_at;

    el('convReplyInput').value = '';
    el('convReplyInput').style.height = 'auto';
    setAdminFile(null);

    await appendAdminMsgBubble(msgRes.data);
    await refreshAttachments(msgRes.data.id);
    renderConversationList(); renderConvStats();
  } finally {
    updateStatusUI(conv.status);
  }
}

// ============================================================
// FINANÇAS
//
// Lê das vistas criadas no v23 e v24, que já fazem as somas em
// euros à taxa do dia de cada transação. Somar aqui no browser
// obrigaria a trazer milhares de linhas e a repetir a lógica.
// ============================================================
var fin = { months: [], airports: [], partners: [], agencies: [], recon: [] };
var finPeriod = 'mtd';
var finView = 'months';

function eur(v) {
  var n = Number(v || 0);
  return new Intl.NumberFormat('en-IE', {
    style: 'currency', currency: 'EUR', maximumFractionDigits: n >= 1000 ? 0 : 2
  }).format(n);
}

function pct(part, whole) {
  var w = Number(whole || 0);
  if (!w) return '—';
  return Math.round((Number(part || 0) / w) * 100) + '%';
}

function monthLabel(iso) {
  var d = new Date(iso + 'T12:00:00');
  return isNaN(d.getTime()) ? iso
    : d.toLocaleDateString('en-GB', { month: 'short', year: '2-digit' });
}

/** Os meses que caem no período escolhido. */
function periodMonths() {
  var now = new Date();
  var y = now.getFullYear();
  var m = now.getMonth();

  var from;
  if (finPeriod === 'mtd') from = new Date(y, m, 1);
  else if (finPeriod === 'last') from = new Date(y, m - 1, 1);
  else if (finPeriod === 'qtd') from = new Date(y, Math.floor(m / 3) * 3, 1);
  else if (finPeriod === 'ytd') from = new Date(y, 0, 1);
  else return fin.months;

  var to = finPeriod === 'last' ? new Date(y, m, 1) : new Date(y, m + 1, 1);

  return fin.months.filter(function (r) {
    var d = new Date(r.month + 'T12:00:00');
    return d >= from && d < to;
  });
}

function sum(rows, field) {
  return rows.reduce(function (t, r) { return t + Number(r[field] || 0); }, 0);
}

async function loadFinance() {
  el('finBody').innerHTML = '<tr><td colspan="8" class="loading-row">Loading...</td></tr>';

  /**
   * As finanças passam por uma função, não por leitura direta.
   *
   * A função verifica o cargo no servidor. As vistas deixaram de
   * ser legíveis a quem não for supervisor — esconder o separador
   * no painel não protegia nada, porque quem quisesse chamava-as
   * da consola do browser.
   */
  var fin = function (nome) {
    return client.rpc('finance_data', { p_view: nome })
      .then(function (r) {
        if (r.error) return { data: null, error: r.error };
        return { data: (r.data || []).map(function (x) { return x; }), error: null };
      });
  };

  var results = await Promise.all([
    fin('finance_monthly'),
    fin('finance_by_airport'),
    fin('finance_by_partner'),
    fin('finance_by_agency'),
    fin('finance_reconciliation')
  ]);

  var names = ['months', 'airports', 'partners', 'agencies', 'recon'];
  var failed = [];

  results.forEach(function (r, i) {
    if (r.error) {
      failed.push(names[i] + ': ' + r.error.message);
      fin[names[i]] = [];
    } else {
      fin[names[i]] = r.data || [];
    }
  });

  if (failed.length) {
    // Quase sempre uma migração por correr. Dizer qual é poupa
    // meia hora de procura.
    el('finNote').innerHTML = '<span class="warn-text">Some views are missing — ' +
      'run the SQL migrations v23, v23b and v24.</span><br>' + escapeHtml(failed.join(' · '));
  }

  renderFinance();
}

function renderFinance() {
  var rows = periodMonths();

  var gross = sum(rows, 'gross_eur');
  var refunded = sum(rows, 'refunded_eur');
  var net = gross - refunded;
  var cost = sum(rows, 'supplier_cost_eur');
  var margin = sum(rows, 'margin_eur');
  var fees = sum(rows, 'stripe_fees_eur');
  var pending = sum(rows, 'awaiting_charge_eur');
  var bookings = sum(rows, 'bookings');
  var paid = sum(rows, 'paid_bookings');
  var cancelled = sum(rows, 'cancelled');
  var agency = sum(rows, 'agency_bookings');
  var later = sum(rows, 'pay_later_bookings');

  el('kGross').textContent = eur(gross);
  el('kGrossSub').textContent = paid + ' paid booking' + (paid === 1 ? '' : 's');

  el('kRefund').textContent = eur(refunded);
  el('kRefundSub').textContent = refunded > 0
    ? pct(refunded, gross) + ' of revenue · ' + cancelled + ' cancelled'
    : 'Nothing refunded';

  el('kCost').textContent = eur(cost);
  el('kCostSub').textContent = cost > 0 ? pct(cost, net) + ' of net revenue' : 'No driver costs yet';

  el('kMargin').textContent = eur(margin);
  el('kMarginSub').textContent = net > 0 ? pct(margin, net) + ' margin' : '—';

  el('kCount').textContent = bookings;
  el('kCountSub').textContent = agency + ' agency · ' + later + ' pay later';

  el('kAvg').textContent = paid ? eur(net / paid) : '—';
  el('kAvgSub').textContent = paid ? 'Per paid booking' : '—';

  el('kPending').textContent = eur(pending);
  el('kPendingSub').textContent = pending > 0 ? 'Cards saved, not yet charged' : 'Nothing waiting';

  el('kFees').textContent = eur(fees);
  el('kFeesSub').textContent = fees > 0 ? pct(fees, gross) + ' of revenue' : 'No fees recorded';

  el('finNote').textContent = rows.length
    ? rows.length + ' month' + (rows.length === 1 ? '' : 's') +
      ' in view · all figures in euros at the rate that applied on the day'
    : 'Nothing in this period yet.';

  renderChart();
  renderFinTable();
  reportHeight();
}

/**
 * Barras em HTML e não numa biblioteca de gráficos.
 *
 * Doze barras não justificam trezentos kilobytes de dependência, e
 * uma biblioteca a mais é uma coisa a mais que parte quando muda de
 * versão.
 */
function renderChart() {
  var rows = fin.months.slice(0, 12).reverse();
  var box = el('finChart');

  if (!rows.length) {
    box.innerHTML = '<div class="no-results" style="width:100%">No months to show yet.</div>';
    return;
  }

  var peak = Math.max.apply(null, rows.map(function (r) {
    return Number(r.net_eur || 0);
  }).concat([1]));

  box.innerHTML = rows.map(function (r) {
    var netValue = Number(r.net_eur || 0);
    var marginValue = Number(r.margin_eur || 0);
    var height = Math.max(2, Math.round((netValue / peak) * 130));
    var inner = netValue > 0
      ? Math.max(0, Math.round((marginValue / netValue) * height))
      : 0;

    return '<div class="fin-bar' + (netValue <= 0 ? ' empty' : '') + '">' +
      '<span class="amt">' + escapeHtml(netValue ? eur(netValue) : '') + '</span>' +
      '<div class="stack" style="height:' + height + 'px" ' +
      'title="' + escapeHtml(monthLabel(r.month) + ': ' + eur(netValue) +
        ' net, ' + eur(marginValue) + ' margin') + '">' +
      (inner ? '<i style="height:' + inner + 'px"></i>' : '') + '</div>' +
      '<span class="lbl">' + escapeHtml(monthLabel(r.month)) + '</span>' +
      '</div>';
  }).join('');
}

var FIN_VIEWS = {
  months: {
    head: ['Month', 'Bookings', 'Revenue', 'Refunds', 'Net', 'Driver cost', 'Margin', 'Margin %'],
    note: 'Every month on record, newest first. Margin is net revenue minus what the drivers were paid.',
    rows: function () {
      return fin.months.map(function (r) {
        var net = Number(r.net_eur || 0);
        return [
          monthLabel(r.month),
          r.bookings,
          eur(r.gross_eur),
          Number(r.refunded_eur) ? '<span class="neg">' + eur(r.refunded_eur) + '</span>' : '—',
          eur(net),
          eur(r.supplier_cost_eur),
          '<span class="pos">' + eur(r.margin_eur) + '</span>',
          pct(r.margin_eur, net)
        ];
      });
    }
  },

  airports: {
    head: ['Airport', 'City', 'Bookings', 'Revenue', 'Margin', 'Average', 'Unassigned'],
    note: 'Where the money is made. The last column is rides nobody took — if it is high at ' +
          'one airport, you need more partners there, not more marketing.',
    rows: function () {
      return fin.airports.map(function (r) {
        return [
          '<strong>' + escapeHtml(r.airport) + '</strong>',
          escapeHtml(r.city || '—'),
          r.bookings,
          eur(r.gross_eur),
          eur(r.margin_eur),
          eur(r.avg_booking_eur),
          Number(r.unassigned)
            ? '<span class="neg">' + r.unassigned + '</span>'
            : '0'
        ];
      });
    }
  },

  partners: {
    head: ['Partner', 'Country', 'Rides', 'Completed', 'Owed total', 'Owed last month', 'Released'],
    note: 'What each company did and what they are owed. The last month column is what goes ' +
          'in this month\u2019s payment run. "Released" counts rides they took and gave back — ' +
          'a number above two or three is worth a conversation.',
    rows: function () {
      return fin.partners.map(function (r) {
        return [
          '<strong>' + escapeHtml(r.trading_name || r.legal_name || '—') + '</strong>' +
          '<br><small style="color:var(--muted)">' + escapeHtml(r.email || '') + '</small>',
          escapeHtml(r.country || '—'),
          r.rides,
          r.completed,
          eur(r.owed_eur),
          '<strong>' + eur(r.owed_last_month_eur) + '</strong>',
          Number(r.times_released)
            ? '<span class="neg">' + r.times_released + '</span>'
            : '0'
        ];
      });
    }
  },

  agencies: {
    head: ['Agency', 'Rate', 'Bookings', 'Billed', 'Discount given', 'Margin', 'Last booking'],
    note: 'Discount given is what the trade rate cost you. Compare it with the margin column: ' +
          'an agency that brings volume can be worth more than a direct customer even at 12% off.',
    rows: function () {
      return fin.agencies.map(function (r) {
        return [
          '<strong>' + escapeHtml(r.agency_name || '—') + '</strong>' +
          '<br><small style="color:var(--muted)">' + escapeHtml(r.email || '') + '</small>',
          (r.trade_rate_pct || 12) + '%',
          r.bookings,
          eur(r.billed_eur),
          '<span class="neg">' + eur(r.discount_given) + '</span>',
          '<span class="pos">' + eur(r.margin_eur) + '</span>',
          r.last_booking ? escapeHtml(r.last_booking) : '—'
        ];
      });
    }
  },

  recon: {
    head: ['Month', 'Settled bookings', 'Quoted', 'Settled', 'Stripe fees', 'Difference', '%'],
    note: 'Quoted is what we told the customer, converted at the ECB rate. Settled is what ' +
          'Stripe actually deposited. A consistently negative difference means the currency ' +
          'margin is too thin, or Stripe is charging more than assumed.',
    rows: function () {
      return fin.recon.map(function (r) {
        var diff = Number(r.difference_eur || 0);
        return [
          monthLabel(r.month),
          r.settled_bookings,
          eur(r.quoted_eur),
          eur(r.settled_eur),
          '<span class="neg">' + eur(r.stripe_fees_eur) + '</span>',
          '<span class="' + (diff < 0 ? 'neg' : 'pos') + '">' + eur(diff) + '</span>',
          '<span class="' + (Number(r.difference_pct) < 0 ? 'neg' : 'pos') + '">' +
            (r.difference_pct || 0) + '%</span>'
        ];
      });
    }
  }
};

function renderFinTable() {
  var view = FIN_VIEWS[finView];
  var rows = view.rows();

  el('finHead').innerHTML = view.head.map(function (h, i) {
    return '<th' + (i > 1 ? ' style="text-align:right"' : '') + '>' + escapeHtml(h) + '</th>';
  }).join('');

  el('finBody').innerHTML = rows.length
    ? rows.map(function (cells) {
        return '<tr>' + cells.map(function (c, i) {
          return '<td' + (i > 1 ? ' class="num-cell"' : '') + '>' + c + '</td>';
        }).join('') + '</tr>';
      }).join('')
    : '<tr><td colspan="' + view.head.length + '" class="no-results">Nothing here yet.</td></tr>';

  el('finViewNote').textContent = view.note;
}

qsa('.fin-period').forEach(function (b) {
  b.addEventListener('click', function () {
    qsa('.fin-period').forEach(function (x) { x.classList.remove('active'); });
    b.classList.add('active');
    finPeriod = b.getAttribute('data-period');
    renderFinance();
  });
});

qsa('.fin-tab').forEach(function (b) {
  b.addEventListener('click', function () {
    qsa('.fin-tab').forEach(function (x) { x.classList.remove('active'); });
    b.classList.add('active');
    finView = b.getAttribute('data-view');
    renderFinTable();
    reportHeight();
  });
});

el('finRefreshBtn').addEventListener('click', loadFinance);

// ---------- exportações ----------

el('finMonthCsv').addEventListener('click', function () {
  if (!fin.months.length) return avisar('Heads up', 'Nothing to export yet.');

  downloadRows(fin.months.map(function (r) {
    return {
      month: r.month,
      bookings: r.bookings,
      paid_bookings: r.paid_bookings,
      cancelled: r.cancelled,
      agency_bookings: r.agency_bookings,
      pay_later_bookings: r.pay_later_bookings,
      revenue_eur: Number(r.gross_eur || 0).toFixed(2),
      refunded_eur: Number(r.refunded_eur || 0).toFixed(2),
      net_eur: Number(r.net_eur || 0).toFixed(2),
      settled_eur: Number(r.settled_eur || 0).toFixed(2),
      stripe_fees_eur: Number(r.stripe_fees_eur || 0).toFixed(2),
      driver_cost_eur: Number(r.supplier_cost_eur || 0).toFixed(2),
      margin_eur: Number(r.margin_eur || 0).toFixed(2),
      vat_eur: Number(r.vat_eur || 0).toFixed(2),
      awaiting_charge_eur: Number(r.awaiting_charge_eur || 0).toFixed(2),
      passengers: r.passengers,
      distance_km: Math.round(Number(r.distance_km || 0))
    };
  }), 'airportlink-monthly');
});

/**
 * O mapa de pagamentos aos motoristas.
 *
 * É o ficheiro que se leva ao banco: uma linha por parceiro, com o
 * IBAN e o valor do mês passado. Só entram os que têm algo a receber.
 */
el('finPayoutCsv').addEventListener('click', async function () {
  var owed = fin.partners.filter(function (r) {
    return Number(r.owed_last_month_eur || 0) > 0;
  });

  if (!owed.length) return avisar('Heads up', 'Nothing owed for last month.');

  var missingIban = owed.filter(function (r) { return !r.payout_iban; });

  if (missingIban.length) {
    if (!await perguntar('Missing bank details', missingIban.length + ' partner(s) have no IBAN on file and cannot be paid:\n\n' +
      missingIban.map(function (r) { return '· ' + (r.legal_name || r.email); }).join('\n') +
      '\n\nExport anyway?')) return;
  }

  downloadRows(owed.map(function (r) {
    return {
      partner: r.legal_name || '',
      trading_name: r.trading_name || '',
      email: r.email || '',
      country: r.country || '',
      iban: r.payout_iban || 'MISSING',
      rides_completed: r.completed,
      amount_eur: Number(r.owed_last_month_eur || 0).toFixed(2)
    };
  }), 'airportlink-payment-run');
});

el('finTxCsv').addEventListener('click', async function () {
  var btn = el('finTxCsv');
  btn.disabled = true;
  btn.textContent = 'Preparing...';

  try {
    // As transações vêm da bookings e não de uma vista: o CSV
    // precisa de detalhe por reserva, e uma vista agregada não o tem.
    var res = await client.from('bookings').select(
      'booking_reference, booking_id, booking_date, booking_time, created_at, charged_at, ' +
      'full_name, email, pickup, dropoff, pickup_airport, pickup_city, passengers, ' +
      'currency, price, price_eur, fx_rate, settled_eur, stripe_fee_eur, ' +
      'refunded_amount_eur, driver_payout_eur, margin_eur, payment_mode, payment_status, ' +
      'status, booked_by, agent_reference, country_from, country_to, cross_border'
    ).order('booking_date', { ascending: false }).limit(5000);

    if (res.error) throw new Error(res.error.message);
    if (!res.data || !res.data.length) return avisar('Heads up', 'No bookings to export.');

    downloadRows(res.data.map(function (b) {
      return {
        reference: b.booking_reference || b.booking_id || '',
        pickup_date: b.booking_date || '',
        pickup_time: String(b.booking_time || '').slice(0, 5),
        booked_on: String(b.created_at || '').slice(0, 10),
        charged_on: String(b.charged_at || '').slice(0, 10),
        customer: b.full_name || '',
        email: b.email || '',
        from: b.pickup || '',
        to: b.dropoff || '',
        airport: b.pickup_airport || '',
        country_from: b.country_from || '',
        country_to: b.country_to || '',
        cross_border: b.cross_border ? 'yes' : 'no',
        passengers: b.passengers || '',
        currency: b.currency || '',
        charged_amount: b.price || '',
        fx_rate: b.fx_rate || '',
        revenue_eur: b.price_eur || '',
        settled_eur: b.settled_eur || '',
        stripe_fee_eur: b.stripe_fee_eur || '',
        refunded_eur: b.refunded_amount_eur || '',
        driver_cost_eur: b.driver_payout_eur || '',
        margin_eur: b.margin_eur || '',
        payment_mode: b.payment_mode || 'now',
        payment_status: b.payment_status || '',
        booking_status: b.status || '',
        agency_booking: b.booked_by ? 'yes' : 'no',
        agency_reference: b.agent_reference || ''
      };
    }), 'airportlink-transactions');
  } catch (e) {
    avisar('Heads up', e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Transactions CSV';
  }
});

// ============================================================
// TEMA
// ============================================================
var ADMIN_THEME_KEY = 'airportlink-admin-theme';

(function theme() {
  var saved;
  try { saved = localStorage.getItem(ADMIN_THEME_KEY); } catch (e) {}
  document.documentElement.setAttribute('data-theme', saved === 'dark' ? 'dark' : 'light');

  el('themeBtn').addEventListener('click', function () {
    var next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem(ADMIN_THEME_KEY, next); } catch (e) {}
  });
})();

// ============================================================
// AVISOS AO VIVO
//
// Três camadas, porque um operador de call centre nem sempre está a
// olhar para o painel: um ponto no menu para quem está, o título a
// piscar para quem tem o painel noutra aba, e uma faixa que desliza
// para quem está ao telefone. O som pode ser desligado — sem isso,
// ao fim de uma hora desliga-se o painel inteiro.
// ============================================================
var alerts = { bookingsTab: 0, supportTab: 0 };
var soundOn = true;
var titleTimer = null;
var BASE_TITLE = document.title;

/**
 * O som segue o estado, e mais nada.
 *
 * Havia um interruptor à parte, e com ele duas coisas a dizerem se
 * o som toca: o estado e o botão. Um agente em Live com o som
 * desligado num separador esquecido perdia chamadas sem perceber
 * porquê — e não tinha como descobrir.
 *
 * Agora é uma regra só: em Live há som, em Break e Offline não.
 * O soundOn continua declarado lá em cima e fica sempre verdadeiro,
 * para o podeTocar funcionar sem se reescrever tudo o que o usa.
 */

/** Duas notas curtas geradas na hora. Sem ficheiro de som para
 *  carregar, e impossível de bloquear por um adblocker. */
/**
 * O som dos avisos.
 *
 * Dois tipos, porque são coisas diferentes: um "tlim" curto para
 * uma reserva nova, e um toque de telefone insistente para uma
 * conversa à espera de resposta.
 *
 * Um contexto de áudio partilhado, criado uma vez: criar um por cada
 * som esgota o limite do browser ao fim de umas dezenas.
 */
var audioCtx = null;

function audio() {
  if (audioCtx) return audioCtx;

  var Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;

  audioCtx = new Ctx();
  return audioCtx;
}

/**
 * Os browsers bloqueiam áudio até haver um gesto na página.
 *
 * Sem isto, o painel pode estar aberto uma manhã inteira sem nunca
 * conseguir tocar — e ninguém percebe porquê, porque não há erro
 * nenhum. Um clique em qualquer sítio desbloqueia.
 */
var audioReady = false;

function unlockAudio() {
  var ctx = audio();
  if (!ctx) return;

  // O resume() devolve uma promessa: o estado pode ainda não ter
  // mudado na linha seguinte. Verificar só de forma síncrona fazia
  // com que o primeiro clique parecesse não funcionar.
  if (ctx.state === 'suspended') {
    var p = ctx.resume();
    if (p && p.then) p.then(marcarPronto, function () {});
  }

  marcarPronto();
}

function marcarPronto() {
  var ctx = audio();
  audioReady = Boolean(ctx) && ctx.state === 'running';

  if (!audioReady) return;

  document.removeEventListener('click', unlockAudio);
  document.removeEventListener('keydown', unlockAudio);
  document.removeEventListener('pointerdown', unlockAudio);
  document.removeEventListener('touchstart', unlockAudio);
  document.body.classList.remove('sound-locked');
}

/**
 * Quatro gestos, não dois.
 *
 * O browser bloqueia o áudio até haver interação — não há forma de
 * contornar isso, e não deve haver: senão qualquer página tocava
 * som ao abrir. O que se pode fazer é apanhar o primeiro gesto
 * possível, seja ele qual for.
 *
 * O pointerdown dispara antes do click, e o touchstart cobre o
 * telemóvel. Assim o desbloqueio acontece no primeiro toque em
 * qualquer sítio, e não só num clique completo.
 */
document.addEventListener('pointerdown', unlockAudio);
document.addEventListener('touchstart', unlockAudio, { passive: true });
document.addEventListener('click', unlockAudio);
document.addEventListener('keydown', unlockAudio);

// Marca o corpo enquanto estiver bloqueado, para o aviso poder
// pulsar em vez de ficar um botão discreto que ninguém lê.
document.body.classList.add('sound-locked');

function tone(freq, startAt, length, volume, shape) {
  var ctx = audio();
  if (!ctx) return;

  var osc = ctx.createOscillator();
  var gain = ctx.createGain();

  osc.type = shape || 'sine';
  osc.frequency.value = freq;

  var t = ctx.currentTime + startAt;
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(volume, t + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + length);

  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(t);
  osc.stop(t + length + 0.02);
}

/** Aviso discreto: uma reserva nova, uma mensagem numa conversa já atendida. */
/**
 * Pode tocar?
 *
 * O estado manda: em Live há som, em Break e Offline não. Foi essa
 * a decisão — quem está em pausa não deve ser chamado por um som,
 * e quem está offline não devia sequer ser interrompido.
 *
 * O interruptor manual continua a existir e ganha a tudo, para
 * quem estiver ao serviço num sítio onde o som não sirva.
 */
function podeTocar() {
  // Live e active: os dois estados em que chegam chats.
  return soundOn && (desk.state === 'live' || desk.state === 'active');
}

/**
 * Toca ignorando o estado.
 *
 * Só para o "ainda estás aqui?". É a única situação em que avisar
 * alguém que está offline faz sentido: foi posto offline sem o ter
 * escolhido, e não tem outra forma de o descobrir.
 */
function forcarTom() {
  var antes = desk.state;
  desk.state = 'live';
  try { ringTone(); } catch (e) {}
  desk.state = antes;
}

/**
 * Pode interromper?
 *
 * Igual ao som, mas para o que aparece no ecrã: o aviso a passar,
 * o título a piscar. Em pausa ou offline o contador continua a
 * subir — o que muda é não haver interrupção.
 *
 * O separador certo mostra o número ao voltar, e nada se perde.
 */
function podeNotificar() {
  return desk.state === 'live' || desk.state === 'active';
}

function beep() {
  if (!podeTocar()) return;
  var ctx = audio();
  if (!ctx) return;
  if (ctx.state === 'suspended') ctx.resume();

  try {
    tone(880, 0, 0.16, 0.18);
    tone(1180, 0.13, 0.2, 0.16);
  } catch (e) {
    console.error('beep:', e);
  }
}

/**
 * Toque de chamada: alguém está à espera com um relógio a correr.
 *
 * Três notas a subir, repetidas duas vezes, bem mais alto do que o
 * aviso comum. É a única coisa no painel que justifica insistir.
 */
function ringTone() {
  if (!podeTocar()) return;
  var ctx = audio();
  if (!ctx) return;
  if (ctx.state === 'suspended') ctx.resume();

  try {
    [0, 0.62].forEach(function (offset) {
      tone(784, offset, 0.14, 0.42, 'triangle');
      tone(988, offset + 0.15, 0.14, 0.42, 'triangle');
      tone(1319, offset + 0.30, 0.26, 0.38, 'triangle');
    });
  } catch (e) {
    console.error('ringTone:', e);
  }
}

function paintAlerts() {
  Object.keys(alerts).forEach(function (tab) {
    var btn = document.querySelector('.tab-btn[data-tab="' + tab + '"]');
    if (!btn) return;
    var dot = btn.querySelector('.dot');
    if (alerts[tab] > 0) {
      if (!dot) {
        dot = document.createElement('span');
        dot.className = 'dot';
        btn.appendChild(dot);
      }
    } else if (dot) {
      dot.remove();
    }
  });

  var total = alerts.bookingsTab + alerts.supportTab;

  if (titleTimer) { clearInterval(titleTimer); titleTimer = null; }
  document.title = BASE_TITLE;

  // O título a piscar é o que funciona com o painel numa aba em
  // segundo plano, que é onde vai estar metade do turno.
  if (total > 0) {
    var flip = false;
    titleTimer = setInterval(function () {
      flip = !flip;
      document.title = flip ? '(' + total + ') New activity' : BASE_TITLE;
    }, 1400);
  }
}

function clearAlerts(tab) {
  if (alerts[tab]) { alerts[tab] = 0; paintAlerts(); }
}

function toast(kind, message, tab) {
  var box = el('toasts');
  var node = document.createElement('div');
  node.className = 'toast';
  node.style.position = 'relative';
  node.innerHTML = '<button class="x" type="button" aria-label="Dismiss">&times;</button>' +
    '<div class="t">' + escapeHtml(kind) + '</div>' +
    '<div class="m">' + escapeHtml(message) + '</div>' +
    '<button class="go" type="button">Open</button>';

  node.querySelector('.x').addEventListener('click', function () { node.remove(); });
  node.querySelector('.go').addEventListener('click', function () {
    switchTab(tab);
    node.remove();
  });

  box.appendChild(node);
  setTimeout(function () { if (node.parentNode) node.remove(); }, 9000);
}

function watchLive() {
  client.channel('admin_live_bookings')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'bookings' },
      function (payload) {
        var b = payload.new || {};

        // Fora de Live a reserva é registada na mesma — só não
        // interrompe. Quem está em pausa vê o contador ao voltar.
        alerts.bookingsTab += 1;
        paintAlerts();
        loadBookings();
        if (!podeNotificar()) return;

        beep();
        toast('New booking',
          (b.full_name || b.email || 'Customer') + ' \u00b7 ' +
          (b.pickup || '') + ' to ' + (b.dropoff || ''), 'bookingsTab');
        loadBookings();
      }).subscribe();

  client.channel('admin_live_messages')
    .on('postgres_changes', {
      event: 'INSERT', schema: 'public', table: 'support_messages',
      filter: 'sender_type=eq.customer'
    }, function (payload) {
      var m = payload.new || {};
      alerts.supportTab += 1;
      paintAlerts();
      if (!podeNotificar()) return;

      beep();
      toast('New message',
        (m.sender_name || 'Customer') + ': ' + String(m.message || '').slice(0, 90),
        'supportTab');
    }).subscribe();
}

// ============================================================
// PAGAMENTOS AGENDADOS
//
// Reservas com pagamento adiado. O cron cobra sozinho 48 horas antes;
// isto serve para ver o que correu mal e agir antes do cliente ligar.
// ============================================================
async function loadCharges() {
  var box = el('chgList');
  box.innerHTML = '<div class="loading-row">Loading...</div>';

  var results = await Promise.all([
    client.from('pending_charges').select('*'),
    client.from('unclaimed_rides').select('*').order('hours_to_pickup')
  ]);

  if (results[0].error) {
    box.innerHTML = '<div class="error-row">' + escapeHtml(results[0].error.message) + '</div>';
  } else {
    charges = results[0].data || [];
    renderCharges();
  }

  unclaimed = results[1].error ? [] : (results[1].data || []);
  renderUnclaimed();
}

function renderCharges() {
  var box = el('chgList');

  var late = charges.filter(function (c) { return Number(c.hours_until_charge) < 0; });
  var soon = charges.filter(function (c) {
    var h = Number(c.hours_until_charge);
    return h >= 0 && h <= 24;
  });
  var failed = charges.filter(function (c) { return c.payment_status === 'charge_failed'; });

  el('mSaved').textContent = charges.length;
  el('mSoon').textContent = soon.length;
  el('mLate').textContent = late.length;
  el('mFailed').textContent = failed.length;

  var needs = late.length + failed.length;
  el('moneyBadge').textContent = needs ? ' (' + needs + ')' : '';

  if (!charges.length) {
    box.innerHTML = '<div class="no-results">Nothing waiting to be charged.</div>';
    return reportHeight();
  }

  box.innerHTML = charges.map(function (c) {
    var hoursToCharge = Number(c.hours_until_charge);
    var isLate = hoursToCharge < 0;
    var isFailed = c.payment_status === 'charge_failed';

    return '<div class="chg-card ' + (isFailed ? 'failed' : (isLate ? 'late' : '')) + '">' +
      '<div class="chg-top"><div>' +
      '<h4>' + escapeHtml(c.full_name || c.email || 'Customer') + '</h4>' +
      '<div class="m">' + escapeHtml(c.booking_reference || c.booking_id || '') +
      ' &middot; ' + escapeHtml(c.email || '') + '<br>' +
      escapeHtml(c.pickup || '') + ' &rarr; ' + escapeHtml(c.dropoff || '') + '</div></div>' +
      '<span class="status ' + (isFailed ? 'cancelled' : (isLate ? 'pending' : 'verified')) + '">' +
      escapeHtml(isFailed ? 'failed' : (isLate ? 'overdue' : 'scheduled')) + '</span></div>' +

      '<div class="chg-facts">' +
      '<div class="chg-fact"><div class="k">Amount</div><div class="v">' +
        escapeHtml(money(c.currency, c.price)) + '</div></div>' +
      '<div class="chg-fact"><div class="k">Charge at</div><div class="v">' +
        escapeHtml(c.charge_at ? formatTime(c.charge_at) : '-') + '</div></div>' +
      '<div class="chg-fact"><div class="k">Pick-up in</div><div class="v">' +
        escapeHtml(Math.round(Number(c.hours_to_pickup)) + 'h') + '</div></div>' +
      '<div class="chg-fact"><div class="k">Attempts</div><div class="v">' +
        escapeHtml(c.charge_attempts || 0) +
        (c.has_card ? '' : ' <small style="color:#fca5a5">no card</small>') + '</div></div>' +
      '</div>' +

      (c.last_charge_error
        ? '<div class="chg-err">' + escapeHtml(c.last_charge_error) + '</div>' : '') +
      '</div>';
  }).join('');

  reportHeight();
}

function renderUnclaimed() {
  var body = el('unclaimedList');

  if (!unclaimed.length) {
    body.innerHTML = '<tr><td colspan="7" class="no-results">Every ride has a partner.</td></tr>';
    return reportHeight();
  }

  body.innerHTML = unclaimed.map(function (r) {
    var hours = Math.round(Number(r.hours_to_pickup));
    var seen = Number(r.partners_that_can_see_it) || 0;
    var urgent = hours < 48;

    return '<tr>' +
      '<td><strong>' + escapeHtml(r.booking_reference || r.booking_id || '') + '</strong>' +
      (r.released_count ? '<br><small style="color:#fbbf24">released ' +
        escapeHtml(r.released_count) + '\u00d7</small>' : '') + '</td>' +
      '<td>' + escapeHtml(r.pickup || '') + '<br><small style="color:var(--muted)">to ' +
        escapeHtml(r.dropoff || '') + '</small></td>' +
      '<td>' + escapeHtml(r.booking_date || '') +
        (r.booking_time ? ' ' + escapeHtml(String(r.booking_time).slice(0, 5)) : '') + '</td>' +
      '<td>' + (r.pickup_airport
        ? '<strong>' + escapeHtml(r.pickup_airport) + '</strong>'
        : '<span class="warn-text">not matched</span>') + '</td>' +
      '<td>' + escapeHtml(r.driver_payout ? money(r.currency, r.driver_payout) : '-') + '</td>' +
      '<td' + (urgent ? ' style="color:#fca5a5;font-weight:700"' : '') + '>' + hours + 'h</td>' +
      '<td' + (seen === 0 ? ' style="color:#fca5a5;font-weight:700"' : '') + '>' + seen + '</td>' +
      '</tr>';
  }).join('');

  reportHeight();
}

el('chgRefreshBtn').addEventListener('click', loadCharges);

// Disparar o ciclo à mão. Precisa do mesmo segredo do cron — não o
// guardamos aqui, é pedido na altura.
el('chgRunBtn').addEventListener('click', async function () {
  var box = el('chgRunMsg');
  box.style.display = 'none';

  var secret = await pedirTexto('Cron secret',
    'This charges every booking that is due right now.\n\n' +
    'Same value as CRON_SECRET on the server.', '', 'Run');
  if (!secret) return;

  el('chgRunBtn').disabled = true;
  el('chgRunBtn').textContent = 'Running...';

  try {
    var res = await fetch(RENDER_URL + '/api/tasks/charge-due', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-cron-secret': secret }
    });
    var result = await res.json();
    if (!res.ok || result.error) throw new Error(result.error || ('HTTP ' + res.status));

    box.style.background = '#052e22';
    box.style.color = '#6ee7b7';
    box.style.border = '1px solid #14532d';
    box.textContent = 'Checked ' + result.checked + ' · charged ' + result.charged +
      ' · failed ' + result.failed + ' · abandoned ' + result.abandoned +
      ' · skipped ' + result.skipped;
    box.style.display = 'block';
    await loadCharges();
  } catch (e) {
    box.style.background = '#7f1d1d';
    box.style.color = '#fecaca';
    box.style.border = '1px solid #991b1b';
    box.textContent = e.message;
    box.style.display = 'block';
  } finally {
    el('chgRunBtn').disabled = false;
    el('chgRunBtn').textContent = 'Run charge cycle now';
  }
});

// ============================================================
// PARCEIROS DE MOTORISTAS
//
// Duas decisões distintas, e a diferença importa:
//   verified  — os três documentos de entrada foram aceites
//   approved  — está tudo completo e pode receber viagens
// Sem essa separação, um parceiro verificado ficava indistinguível
// de um que ainda não tinha mandado nada.
// ============================================================
function showPtError(text) {
  var box = el('ptError');
  if (!text) { box.style.display = 'none'; return; }
  box.textContent = text;
  box.style.display = 'block';
  reportHeight();
}

async function loadPartners() {
  var box = el('ptList');
  box.innerHTML = '<div class="loading-row">Loading...</div>';
  showPtError('');

  // Sem o filtro de 'draft'. Uma conta registada mas por submeter
  // ficava invisível aqui — o que dava zero parceiros com contas
  // reais na base de dados, e nenhuma forma de perceber porquê.
  //
  // São precisamente essas que interessa ver: alguém registou-se e
  // ficou a meio. Um telefonema resolve o que o silêncio não resolve.
  var res = await client.from('driver_partners')
    .select('*')
    .order('created_at', { ascending: false });

  if (res.error) {
    box.innerHTML = '<div class="error-row">' + escapeHtml(res.error.message) + '</div>';
    return;
  }

  partners = res.data || [];
  if (!partners.length) {
    el('ptWaiting').textContent = '0';
    el('ptVerified').textContent = '0';
    el('ptLive').textContent = '0';
    el('ptTotal').textContent = '0';
    el('partnersBadge').textContent = '';
    box.innerHTML = '<div class="no-results">No applications yet.</div>';
    return reportHeight();
  }

  var ids = partners.map(function (p) { return p.id; });

  // Carregado à parte porque a lista precisa de contagens que não
  // vivem na tabela do parceiro.
  var results = await Promise.all([
    client.from('compliance_documents').select('*').in('partner_id', ids),
    client.from('drivers').select('id, partner_id, full_name, phone, status').in('partner_id', ids),
    client.from('partner_vehicles').select('id, partner_id, make, model, plate, seats, status').in('partner_id', ids),
    client.from('partner_zones').select('partner_id, zone_code').in('partner_id', ids),
    client.from('document_requirements').select('*').eq('active', true).order('sort_order')
  ]);

  var docs = results[0].data || [], drvs = results[1].data || [];
  var vehs = results[2].data || [], zones = results[3].data || [];
  var reqs = results[4].data || [];

  partners.forEach(function (p) {
    p._docs = docs.filter(function (d) { return d.partner_id === p.id; });
    p._drivers = drvs.filter(function (d) { return d.partner_id === p.id; });
    p._vehicles = vehs.filter(function (v) { return v.partner_id === p.id; });
    p._zones = zones.filter(function (z) { return z.partner_id === p.id; }).map(function (z) { return z.zone_code; });
    p._reqs = reqs.filter(function (r) { return r.country === (p.country || 'PT'); });
  });

  var waiting = partners.filter(needsAction).length;

  // O 'verified' desapareceu quando a revisão passou a ser única.
  // Este número passa a contar quem se registou e ficou a meio — que
  // é o que realmente pede uma acção da tua parte.
  var stalled = partners.filter(function (p) {
    return p.status === 'draft' || p.status === 'action_required';
  }).length;

  el('ptWaiting').textContent = waiting;
  el('ptVerified').textContent = stalled;
  el('ptLive').textContent = partners.filter(function (p) { return p.status === 'approved'; }).length;
  el('ptTotal').textContent = partners.length;
  el('partnersBadge').textContent = waiting ? ' (' + waiting + ')' : '';

  renderPartners();
  paintTabAlerts();
}

// "À espera de ti" cobre dois casos: uma candidatura por rever, e um
// parceiro verificado que já completou tudo e espera ativação.
function needsAction(p) {
  if (p.status === 'submitted' || p.status === 'in_review') return true;
  if (p.status === 'verified') return activationComplete(p);
  return false;
}

/**
 * Já entregou tudo e está à espera de uma decisão.
 *
 * Diferente de "needs action", que inclui quem submeteu mas ainda
 * tem papéis em falta. Este filtro é para quem só falta carregar
 * num botão — e é onde uma candidatura parada custa um parceiro.
 */
function readyToApprove(p) {
  if (p.status === 'approved' || p.status === 'rejected') return false;

  var need = (p._reqs || []).filter(function (r) {
    return r.scope === 'company' && r.stage === 'signup' && r.mandatory;
  });

  if (!need.length) return false;

  return need.every(function (r) {
    return (p._docs || []).some(function (d) {
      return d.requirement_code === r.code && !d.driver_id &&
        !d.vehicle_id && d.status === 'approved';
    });
  });
}

function activationComplete(p) {
  var need = (p._reqs || []).filter(function (r) { return r.mandatory && r.stage === 'activation'; });

  function has(code, driverId, vehicleId) {
    return (p._docs || []).some(function (d) {
      return d.requirement_code === code &&
        (d.driver_id || null) === (driverId || null) &&
        (d.vehicle_id || null) === (vehicleId || null);
    });
  }

  var drivers = (p._drivers || []).filter(function (d) { return d.status !== 'removed'; });
  var vehicles = (p._vehicles || []).filter(function (v) { return v.status !== 'removed'; });

  if (!drivers.length || !vehicles.length) return false;
  if (!(p._zones || []).length) return false;
  if (!p.payout_iban) return false;

  var driverOk = drivers.every(function (d) {
    return need.filter(function (r) { return r.scope === 'driver'; })
      .every(function (r) { return has(r.code, d.id, null); });
  });
  var vehicleOk = vehicles.every(function (v) {
    return need.filter(function (r) { return r.scope === 'vehicle'; })
      .every(function (r) { return has(r.code, null, v.id); });
  });

  return driverOk && vehicleOk;
}

function missingForActivation(p) {
  var out = [];
  var drivers = (p._drivers || []).filter(function (d) { return d.status !== 'removed'; });
  var vehicles = (p._vehicles || []).filter(function (v) { return v.status !== 'removed'; });

  if (!drivers.length) out.push('no chauffeurs');
  if (!vehicles.length) out.push('no vehicles');
  if (!(p._zones || []).length) out.push('no service zones');
  if (!p.payout_iban) out.push('no bank details');

  var need = (p._reqs || []).filter(function (r) { return r.mandatory && r.stage === 'activation'; });
  function has(code, driverId, vehicleId) {
    return (p._docs || []).some(function (d) {
      return d.requirement_code === code &&
        (d.driver_id || null) === (driverId || null) &&
        (d.vehicle_id || null) === (vehicleId || null);
    });
  }
  drivers.forEach(function (d) {
    need.filter(function (r) { return r.scope === 'driver'; }).forEach(function (r) {
      if (!has(r.code, d.id, null)) out.push(r.label + ' for ' + d.full_name);
    });
  });
  vehicles.forEach(function (v) {
    need.filter(function (r) { return r.scope === 'vehicle'; }).forEach(function (r) {
      if (!has(r.code, null, v.id)) out.push(r.label + ' for ' + v.plate);
    });
  });

  return out;
}

function docLabel(p, code) {
  var r = (p._reqs || []).find(function (x) { return x.code === code; });
  return r ? r.label : code;
}

function renderPartners() {
  var box = el('ptList');
  var list = partners.slice();

  // 'all' e vazio mostram tudo. Sem esta linha o 'all' era tratado
  // como um estado e a lista vinha vazia.
  if (ptFilters.status === 'ready') list = list.filter(readyToApprove);
  else if (ptFilters.status === 'needs') list = list.filter(needsAction);
  else if (ptFilters.status && ptFilters.status !== 'all') {
    list = list.filter(function (p) { return p.status === ptFilters.status; });
  }

  if (ptFilters.search) {
    var q = ptFilters.search.toLowerCase();
    list = list.filter(function (p) {
      return [p.legal_name, p.trading_name, p.vat_number, p.email, p.country, p.contact_name]
        .filter(Boolean).join(' ').toLowerCase().indexOf(q) !== -1;
    });
  }

  if (!list.length) {
    box.innerHTML = '<div class="no-results">Nothing matches this filter.</div>';
    return reportHeight();
  }

  box.innerHTML = list.map(function (p) {
    var statusClass = p.status === 'approved' ? 'completed'
      : (p.status === 'rejected' || p.status === 'suspended') ? 'cancelled'
      : (p.status === 'verified' ? 'verified' : 'pending');

    var signupReqs = (p._reqs || []).filter(function (r) {
      return r.scope === 'company' && r.stage === 'signup' && r.mandatory;
    });

    var docRows = signupReqs.map(function (r) {
      var d = (p._docs || []).find(function (x) {
        return x.requirement_code === r.code && !x.driver_id && !x.vehicle_id;
      });
      if (!d) {
        return '<div class="pt-doc"><div><div class="n">' + escapeHtml(r.label) + '</div>' +
          '<div class="pt-missing">Not uploaded</div></div></div>';
      }
      var expired = d.expires_on && new Date(d.expires_on) < new Date();
      var rejected = d.status === 'rejected';

      return '<div class="pt-doc' + (rejected ? ' rejected' : '') +
        (d.status === 'approved' ? ' approved' : '') + '"><div>' +
        '<div class="n">' + escapeHtml(r.label) +
        ' <span class="doc-state ' + escapeHtml(d.status || 'pending') + '">' +
        escapeHtml(d.status === 'pending' ? 'to review' : (d.status || '')) + '</span></div>' +
        '<div class="m">' + escapeHtml(d.file_name || 'file') +
        (d.expires_on ? ' &middot; valid until ' + escapeHtml(d.expires_on) : '') +
        (expired ? ' &middot; <span style="color:#fca5a5">EXPIRED</span>' : '') + '</div>' +
        (rejected && d.rejection_reason
          ? '<div class="pt-missing" style="margin-top:6px">Told them: ' +
            escapeHtml(d.rejection_reason) + '</div>'
          : '') +
        '</div>' +
        '<div class="r">' +
        '<button class="doc-open" data-doc="' + escapeHtml(d.file_path) + '" type="button">Open</button>' +
        (d.status !== 'approved'
          ? '<button class="doc-ok" data-docok="' + escapeHtml(d.id) + '" type="button">Accept</button>'
          : '') +
        (rejected
          ? ''
          : '<button class="doc-no" data-docno="' + escapeHtml(d.id) + '" type="button">Reject</button>') +
        '</div></div>';
    }).join('');

    // Documentos de ativação, agrupados por motorista e veículo.
    var extraDocs = (p._docs || []).filter(function (d) { return d.driver_id || d.vehicle_id; });
    if (extraDocs.length) {
      docRows += extraDocs.map(function (d) {
        var owner = d.driver_id
          ? ((p._drivers || []).find(function (x) { return x.id === d.driver_id; }) || {}).full_name
          : ((p._vehicles || []).find(function (x) { return x.id === d.vehicle_id; }) || {}).plate;
        var expired = d.expires_on && new Date(d.expires_on) < new Date();
        return '<div class="pt-doc"><div><div class="n">' + escapeHtml(docLabel(p, d.requirement_code)) +
          ' <span class="m">— ' + escapeHtml(owner || '?') + '</span></div>' +
          '<div class="m">' + escapeHtml(d.file_name || 'file') +
          (d.expires_on ? ' &middot; valid until ' + escapeHtml(d.expires_on) : '') +
          (expired ? ' &middot; <span style="color:#fca5a5">EXPIRED</span>' : '') + '</div></div>' +
          '<div class="r"><button class="doc-open" data-doc="' + escapeHtml(d.file_path) + '" type="button">Open</button></div>' +
          '</div>';
      }).join('');
    }

    var missing = p.status === 'verified' ? missingForActivation(p) : [];
    var activationLine = p.status === 'verified'
      ? (missing.length
          ? '<div class="pt-missing" style="margin-bottom:12px">Still missing: ' +
            escapeHtml(missing.join(', ')) + '</div>'
          : '<div style="color:#6ee7b7;font-size:12.5px;margin-bottom:12px">' +
            'Activation complete — ready to go live.</div>')
      : '';

    var actions = '<div class="pt-actions">' +
      '<input type="text" placeholder="Reason (shown to the partner if rejected)" data-reason="' + escapeHtml(p.id) + '">';

    // Uma só decisão. O 'Verify documents' desapareceu: os
    // documentos aceitam-se um a um acima, e aqui decide-se a conta.
    if (['submitted', 'in_review', 'verified', 'action_required'].indexOf(p.status) !== -1) {
      actions += '<button class="btn-activate" data-decide="approved|' + escapeHtml(p.id) + '">Approve and go live</button>';
    }
    if (p.status === 'approved') {
      actions += '<button class="btn-suspend" data-decide="suspended|' + escapeHtml(p.id) + '">Suspend</button>';
    }
    if (p.status === 'suspended' || p.status === 'rejected') {
      actions += '<button class="btn-activate" data-decide="approved|' + escapeHtml(p.id) + '">Reinstate</button>';
    }
    if (p.status !== 'rejected') {
      actions += '<button class="btn-reject" data-decide="rejected|' + escapeHtml(p.id) + '">Reject</button>';
    }
    actions += '</div>';

    /**
     * O ponto da situação, numa linha.
     *
     * Os documentos apareciam um a um, e para saber se faltava
     * alguma coisa era preciso lê-los todos. Com sete requisitos e
     * vinte candidaturas, ninguém faz isso.
     *
     * Esta barra responde à pergunta que se faz primeiro: falta
     * alguma coisa, ou está pronto para decidir?
     */
    var entregues = signupReqs.filter(function (r) {
      return (p._docs || []).some(function (x) {
        return x.requirement_code === r.code && !x.driver_id && !x.vehicle_id;
      });
    }).length;

    var aprovados = signupReqs.filter(function (r) {
      return (p._docs || []).some(function (x) {
        return x.requirement_code === r.code && !x.driver_id &&
          !x.vehicle_id && x.status === 'approved';
      });
    }).length;

    var recusados = (p._docs || []).filter(function (x) {
      return x.status === 'rejected';
    }).length;

    var expirados = (p._docs || []).filter(function (x) {
      return x.expires_on && new Date(x.expires_on) < new Date();
    }).length;

    var total = signupReqs.length;
    var completo = total > 0 && aprovados === total;

    var barra = '<div class="pt-prog' + (completo ? ' done' : '') + '">' +
      '<div class="pt-bar"><i style="width:' +
      (total ? Math.round(aprovados / total * 100) : 0) + '%"></i>' +
      '<u style="width:' +
      (total ? Math.round(entregues / total * 100) : 0) + '%"></u></div>' +
      '<span class="pt-prog-n">' + aprovados + '/' + total + ' approved</span>' +
      (entregues > aprovados
        ? '<span class="pt-tag wait">' + (entregues - aprovados) + ' to review</span>'
        : '') +
      (total > entregues
        ? '<span class="pt-tag miss">' + (total - entregues) + ' missing</span>'
        : '') +
      (recusados
        ? '<span class="pt-tag bad">' + recusados + ' rejected</span>' : '') +
      (expirados
        ? '<span class="pt-tag bad">' + expirados + ' expired</span>' : '') +
      (completo && p.status !== 'approved'
        ? '<span class="pt-tag ok">Ready to approve</span>' : '') +
      '</div>';

    return '<div class="pt-card ' + (needsAction(p) ? 'needs' : '') + '">' +
      '<div class="pt-head"><div>' +
      '<h3>' + escapeHtml(p.legal_name || '(no name)') + '</h3>' +
      (p.trading_name && p.trading_name !== p.legal_name
        ? '<div class="who">Trading as ' + escapeHtml(p.trading_name) + '</div>' : '') +
      '<div class="who">' + escapeHtml(p.contact_name || '-') +
      (p.contact_role ? ', ' + escapeHtml(p.contact_role) : '') +
      ' &middot; ' + escapeHtml(p.email || '') +
      (p.submitted_at ? '<br>Submitted ' + escapeHtml(formatTime(p.submitted_at)) : '') +
      '</div></div>' +
      '<span class="status ' + statusClass + '">' + escapeHtml(p.status) + '</span></div>' +

      // O ponto da situação, logo abaixo do nome. É a primeira
      // pergunta que se faz e era a última a ter resposta.
      barra +

      '<div class="pt-facts">' +
      '<div class="pt-fact"><div class="k">VAT</div><div class="v">' + escapeHtml(p.vat_number || '-') + '</div></div>' +
      '<div class="pt-fact"><div class="k">Country</div><div class="v">' + escapeHtml(p.country || '-') + '</div></div>' +
      '<div class="pt-fact"><div class="k">Phone</div><div class="v">' + escapeHtml(p.contact_phone || '-') +
        (p.emergency_phone ? '<br><small style="color:var(--muted)">24h: ' + escapeHtml(p.emergency_phone) + '</small>' : '') +
        '</div></div>' +
      '<div class="pt-fact"><div class="k">Fleet</div><div class="v">' +
        (p._drivers || []).length + ' drv &middot; ' + (p._vehicles || []).length + ' veh<br>' +
        '<small style="color:var(--muted)">' + ((p._zones || []).length) + ' zones</small></div></div>' +
      '</div>' +

      (p.registered_address
        ? '<div class="who" style="margin-bottom:12px;color:var(--muted);font-size:12.5px">' +
          escapeHtml(p.registered_address) + (p.city ? ', ' + escapeHtml(p.city) : '') +
          (p.postal_code ? ' ' + escapeHtml(p.postal_code) : '') + '</div>'
        : '') +

      activationLine +
      (docRows ? '<div class="pt-docs">' + docRows + '</div>' : '') +
      (p.payout_iban ? '<div class="who" style="margin-bottom:12px;font-size:12.5px">IBAN: ' +
        escapeHtml(p.payout_iban) + (p.payout_holder ? ' &middot; ' + escapeHtml(p.payout_holder) : '') + '</div>' : '') +
      (p.rejection_reason ? '<div class="pt-missing" style="margin-bottom:12px">Rejected: ' +
        escapeHtml(p.rejection_reason) + '</div>' : '') +
      actions + '</div>';
  }).join('');

  qsa('[data-doc]').forEach(function (b) {
    b.addEventListener('click', function () { openPartnerDoc(b.getAttribute('data-doc'), b); });
  });
  qsa('[data-decide]').forEach(function (b) {
    b.addEventListener('click', function () {
      var parts = b.getAttribute('data-decide').split('|');
      decidePartner(parts[1], parts[0], b);
    });
  });

  qsa('[data-docok]').forEach(function (b) {
    b.addEventListener('click', function () {
      decideDocument(b.getAttribute('data-docok'), 'approved', null, b);
    });
  });

  qsa('[data-docno]').forEach(function (b) {
    b.addEventListener('click', async function () {
      // O motivo é escrito ali mesmo e vai literalmente para o
      // parceiro. Pedi-lo aqui é mais barato do que responder
      // depois ao email dele a perguntar o que estava errado.
      var why = await pedirTexto('Reject document',
        'Why can we not accept this document?\n\n' +
        'The partner reads exactly what you write. Be specific:\n' +
        '"The insurance expired in March" beats "wrong document".', '', 'Reject');

      if (!why || !why.trim()) return;
      decideDocument(b.getAttribute('data-docno'), 'rejected', why.trim(), b);
    });
  });

  reportHeight();
}

async function openPartnerDoc(path, button) {
  if (!path) return avisar('Heads up', 'This document has no stored path.');
  button.disabled = true;
  try {
    var res = await client.storage.from(PARTNER_BUCKET).createSignedUrl(path, 300);
    if (res.error || !res.data) throw new Error((res.error && res.error.message) || 'unknown');
    window.open(res.data.signedUrl, '_blank', 'noopener');
  } catch (e) {
    console.error('signed url:', e, '| path:', path);
    avisar('Heads up', 'Could not open the document.\n\nPath: ' + path + '\nError: ' + e.message);
  } finally {
    button.disabled = false;
  }
}

// A revisão de parceiros vive no serviço dos motoristas, não na API
// principal. Apontar para o sítio errado dava 404.
var DRIVERS_URL = CFG.driversUrl || 'https://drivers.airportlink.app';

/**
 * Aceitar ou recusar um documento.
 *
 * Recusar põe a conta em action_required — não em rejected. O
 * parceiro não foi recusado: tem uma coisa para corrigir, e todo o
 * resto do trabalho dele fica intacto.
 */
async function decideDocument(documentId, decision, reason, button) {
  button.disabled = true;
  var original = button.textContent;
  button.textContent = '...';

  try {
    var headers = await authHeaders();

    var res = await fetch(DRIVERS_URL + '/api/admin/partner/document', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({ document_id: documentId, decision: decision, reason: reason })
    });

    var text = await res.text();
    var result;

    try {
      result = JSON.parse(text);
    } catch (e) {
      throw new Error('The drivers service returned an unexpected response (HTTP ' +
        res.status + '). It may be starting up.');
    }

    if (!res.ok || result.error) throw new Error(result.error || ('HTTP ' + res.status));

    await loadPartners();
  } catch (e) {
    avisar('Heads up', e.message);
    button.disabled = false;
    button.textContent = original;
  }
}

async function decidePartner(partnerId, decision, button) {
  showPtError('');
  var p = partners.find(function (x) { return x.id === partnerId; });
  var name = (p && p.legal_name) || 'this company';
  var input = document.querySelector('[data-reason="' + partnerId + '"]');
  var reason = input ? input.value.trim() : '';

  var confirmText = {
    verified: 'Mark ' + name + ' as verified? Their entry documents are accepted and they can start adding chauffeurs and vehicles.',
    approved: 'Take ' + name + ' live? They will start receiving ride offers.',
    suspended: 'Suspend ' + name + '? They stop receiving offers immediately.',
    rejected: 'Reject ' + name + '? They will see the reason you typed.'
  }[decision];

  if (decision === 'rejected' && !reason) {
    return showPtError('Please type a reason before rejecting — the partner sees it.');
  }
  if (!await perguntar('Confirm', confirmText)) return;

  var label = button.textContent;
  button.disabled = true;
  button.textContent = 'Saving...';

  try {
    var res = await fetch(DRIVERS_URL + '/api/admin/partner/review', {
      method: 'POST',
      headers: await authHeaders(),
      body: JSON.stringify({ partner_id: partnerId, decision: decision, reason: reason || undefined })
    });
    var result = await res.json();
    if (!res.ok || result.error) throw new Error(result.error || ('HTTP ' + res.status));
    await loadPartners();
  } catch (e) {
    console.error('decide:', e);
    showPtError(e.message);
    button.disabled = false;
    button.textContent = label;
  }
}

el('ptSearchBtn').addEventListener('click', function () {
  ptFilters = { search: el('ptSearch').value.trim(), status: el('ptStatusFilter').value };
  renderPartners();
  paintTabAlerts();
});
el('ptResetBtn').addEventListener('click', function () {
  el('ptSearch').value = '';
  el('ptStatusFilter').value = 'needs';
  ptFilters = { search: '', status: 'all' };
  loadPartners();
});
el('ptStatusFilter').addEventListener('change', function () {
  ptFilters.status = el('ptStatusFilter').value;
  renderPartners();
  paintTabAlerts();
});

// ============================================================
// TRAVEL AGENTS
//
// A leitura vem da tabela travel_agents; a escrita passa pelo
// servidor. A tabela não tem política de INSERT nem de UPDATE para o
// papel authenticated — e o admin também é authenticated. Sem isso,
// um agente aprovava-se a si próprio com um update no browser.
// ============================================================
/**
 * A sessão renova-se sozinha, e o painel dá por isso.
 *
 * O autoRefreshToken do Supabase renova o token de hora a hora, mas
 * só enquanto a página está viva e visível. Um separador em segundo
 * plano durante a noite acorda com o token expirado, e o painel só
 * descobria isso quando o pedido seguinte falhava — a meio de um
 * turno, com conversas abertas.
 *
 * Isto faz três coisas:
 *
 *  - Renova à força quando o separador volta à frente.
 *  - Ouve o evento de renovação e continua sem interromper nada.
 *  - Se a sessão morrer mesmo, diz porquê em vez de deixar o
 *    painel a falhar em silêncio.
 */
(function vigiarSessao() {
  client.auth.onAuthStateChange(function (evento, sessao) {
    if (evento === 'TOKEN_REFRESHED') {
      // Renovou-se sozinha. Não há nada a fazer — mas convém saber
      // que aconteceu quando se lê a consola à procura de um
      // problema.
      console.log('[desk] session refreshed');
      return;
    }

    if (evento === 'SIGNED_OUT' || (!sessao && currentAdmin)) {
      console.warn('[desk] session ended');
      avisarSessaoMorta();
    }
  });

  /**
   * Ao voltar ao separador, renova já.
   *
   * O browser suspende os temporizadores de separadores em segundo
   * plano. Depois de umas horas escondido, o relógio de renovação
   * do Supabase não correu — e a primeira coisa que o agente faz ao
   * voltar é carregar num botão que falha.
   */
  document.addEventListener('visibilitychange', async function () {
    if (document.hidden || !currentAdmin) return;

    try {
      var r = await client.auth.getSession();

      if (!r.data || !r.data.session) {
        return avisarSessaoMorta();
      }

      // Se falta menos de dez minutos, força a renovação em vez de
      // esperar pelo relógio.
      var expira = (r.data.session.expires_at || 0) * 1000;

      if (expira && expira - Date.now() < 10 * 60000) {
        await client.auth.refreshSession();
        console.log('[desk] session refreshed on focus');
      }

      // E recarrega a fila: enquanto estivemos fora, o mundo mudou.
      loadDesk();
    } catch (e) {
      console.error('[desk] session check:', e.message);
    }
  });
})();

var sessaoMorta = false;

function avisarSessaoMorta() {
  if (sessaoMorta) return;
  sessaoMorta = true;

  /**
   * Parar de pedir a fila.
   *
   * Sem sessão, cada pedido devolve 403. De dez em dez segundos,
   * indefinidamente, com a página aberta — enche a consola de
   * erros e o servidor de pedidos inúteis.
   */
  if (desk.filaTimer) { clearInterval(desk.filaTimer); desk.filaTimer = null; }
  if (filaAgendada) { clearTimeout(filaAgendada); filaAgendada = null; }

  /**
   * Uma sessão que morre a meio de um turno não pode ser silenciosa.
   *
   * O agente continuaria a ver a fila antiga, a carregar em botões
   * que não fazem nada, e as conversas dele ficariam sem ninguém
   * sem que ele soubesse.
   */
  document.body.setAttribute('data-duty', 'offline');

  avisar('Your session ended',
    'You have been signed out — this happens if the browser sat idle for a ' +
    'long time. Your conversations are still assigned to you. Sign in again ' +
    'to pick them up.').then(function () {
      window.location.reload();
    });
}

async function authHeaders() {
  var s = await client.auth.getSession();
  var token = s.data && s.data.session && s.data.session.access_token;
  if (!token) throw new Error('Your admin session expired. Sign in again.');

  // Se a sessão trocou desde que entrámos, é melhor dizê-lo agora do
  // que deixar o servidor devolver um 403 opaco.
  if (currentAdmin && s.data.session.user &&
      s.data.session.user.id !== currentAdmin.user.id) {
    throw new Error('This browser is now signed in as ' + s.data.session.user.email +
      '. Sign out and sign in again with your admin account.');
  }

  return { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token };
}

function showAgentError(text) {
  var box = el('agentError');
  if (!text) { box.style.display = 'none'; return; }
  box.textContent = text;
  box.style.display = 'block';
  reportHeight();
}

async function loadAgents() {
  var box = el('agentList');
  box.innerHTML = '<div class="loading-row">Loading...</div>';
  showAgentError('');

  // travel_agents é a tabela das agências. Os clientes vivem na
  // contacts e não aparecem aqui.
  var res = await client.from('travel_agents')
    .select('id, email, contact_name, representative_role, legal_name, agency_name, agency_vat, agency_country, agency_website, agency_phone, note, status, commission, applied_at, reviewed_at')
    .order('applied_at', { ascending: false });

  if (res.error) {
    box.innerHTML = '<div class="error-row">' + escapeHtml(res.error.message) + '</div>';
    return;
  }

  agents = res.data || [];

  el('agentPendingCount').textContent = agents.filter(function (a) { return a.status === 'pending'; }).length;
  el('agentApprovedCount').textContent = agents.filter(function (a) { return a.status === 'approved'; }).length;
  el('agentRejectedCount').textContent = agents.filter(function (a) { return a.status === 'rejected'; }).length;

  var pending = agents.filter(function (a) { return a.status === 'pending'; }).length;
  el('agentsBadge').textContent = pending ? ' (' + pending + ')' : '';

  var bookingRes = await client.from('bookings').select('id').not('booked_by', 'is', null);
  el('agentBookingsCount').textContent = (bookingRes.data || []).length;

  renderAgents();
  paintTabAlerts();
}

function renderAgents() {
  var box = el('agentList');
  var list = agents.slice();

  if (agentFilters.status && agentFilters.status !== 'all') {
    list = list.filter(function (a) { return a.status === agentFilters.status; });
  }
  if (agentFilters.search) {
    var s = agentFilters.search.toLowerCase();
    list = list.filter(function (a) {
      return (a.agency_name || '').toLowerCase().indexOf(s) !== -1 ||
             (a.legal_name || '').toLowerCase().indexOf(s) !== -1 ||
             (a.contact_name || '').toLowerCase().indexOf(s) !== -1 ||
             (a.email || '').toLowerCase().indexOf(s) !== -1 ||
             (a.agency_country || '').toLowerCase().indexOf(s) !== -1;
    });
  }

  if (!list.length) {
    box.innerHTML = '<div class="no-results">No applications match this filter.</div>';
    return reportHeight();
  }

  box.innerHTML = list.map(function (a) {
    var pending = a.status === 'pending';
    var site = a.agency_website
      ? '<a class="agent-link" href="' + escapeHtml(a.agency_website) + '" target="_blank" rel="noopener">' +
        escapeHtml(a.agency_website) + '</a>'
      : '-';

    var rateInput = '<label style="font-size:12.5px;color:var(--muted)">Rate %</label>' +
      '<input type="number" min="1" max="60" step="0.5" value="' + escapeHtml(a.commission || 12) +
      '" data-rate-for="' + escapeHtml(a.id) + '">';

    var actions;
    if (pending) {
      actions = rateInput +
        '<button class="btn-ok" data-approve="' + escapeHtml(a.id) + '">Approve</button>' +
        '<button class="btn-no" data-reject="' + escapeHtml(a.id) + '">Reject</button>';
    } else if (a.status === 'approved') {
      actions = rateInput +
        '<button class="btn-ok" data-approve="' + escapeHtml(a.id) + '">Update rate</button>' +
        '<button class="btn-no" data-reject="' + escapeHtml(a.id) + '">Revoke access</button>';
    } else {
      actions = rateInput +
        '<button class="btn-ok" data-approve="' + escapeHtml(a.id) + '">Approve now</button>';
    }

    return '<div class="agent-card ' + (pending ? 'pending' : '') + '">' +
      '<div class="agent-head"><div>' +
      '<h3>' + escapeHtml(a.legal_name || a.agency_name || '(no company name)') + '</h3>' +
      (a.agency_name && a.legal_name && a.agency_name !== a.legal_name
        ? '<div class="who">Trading as ' + escapeHtml(a.agency_name) + '</div>' : '') +
      '<div class="who">' + escapeHtml(a.contact_name || '-') +
      (a.representative_role ? ', ' + escapeHtml(a.representative_role) : '') +
      ' &middot; ' + escapeHtml(a.email || '-') +
      (a.applied_at ? '<br>Applied ' + escapeHtml(formatTime(a.applied_at)) : '') +
      (a.reviewed_at ? ' &middot; reviewed ' + escapeHtml(formatTime(a.reviewed_at)) : '') +
      '</div></div>' +
      '<span class="status ' + (a.status === 'approved' ? 'completed' : (a.status === 'rejected' ? 'cancelled' : 'pending')) + '">' +
      escapeHtml(a.status) + (a.status === 'approved' ? ' &middot; ' + escapeHtml(a.commission || 12) + '%' : '') +
      '</span></div>' +
      '<div class="agent-facts">' +
      '<div class="agent-fact"><div class="k">Country</div><div class="v">' + escapeHtml(a.agency_country || '-') + '</div></div>' +
      '<div class="agent-fact"><div class="k">VAT</div><div class="v">' + escapeHtml(a.agency_vat || '-') + '</div></div>' +
      '<div class="agent-fact"><div class="k">Phone</div><div class="v">' + escapeHtml(a.agency_phone || '-') + '</div></div>' +
      '<div class="agent-fact"><div class="k">Website</div><div class="v">' + site + '</div></div>' +
      '</div>' +
      (a.note ? '<div class="agent-note-box">' + escapeHtml(a.note) + '</div>' : '') +
      '<div class="agent-actions">' + actions + '</div></div>';
  }).join('');

  qsa('[data-approve]').forEach(function (b) {
    b.addEventListener('click', function () {
      var id = b.getAttribute('data-approve');
      var input = document.querySelector('[data-rate-for="' + id + '"]');
      reviewAgent(id, 'approved', input ? input.value : null, b);
    });
  });

  qsa('[data-reject]').forEach(function (b) {
    b.addEventListener('click', async function () {
      var id = b.getAttribute('data-reject');
      var agent = agents.find(function (a) { return a.id === id; });
      var name = (agent && agent.agency_name) || 'this agency';
      if (!await perguntar('Reject agency', 'Reject ' + name + '? They lose the partner rate immediately.')) return;
      reviewAgent(id, 'rejected', null, b);
    });
  });

  reportHeight();
}

async function reviewAgent(agentId, decision, commission, button) {
  showAgentError('');
  var original = button ? button.textContent : '';
  if (button) { button.disabled = true; button.textContent = 'Saving...'; }

  try {
    var res = await fetch(RENDER_URL + '/api/agent/review', {
      method: 'POST',
      headers: await authHeaders(),
      body: JSON.stringify({
        agent_id: agentId,
        decision: decision,
        commission: commission ? Number(commission) : undefined
      })
    });

    var result = await res.json();
    if (!res.ok || result.error) throw new Error(result.error || ('HTTP ' + res.status));

    await loadAgents();
  } catch (e) {
    console.error('review error:', e);
    showAgentError(e.message);
    if (button) { button.disabled = false; button.textContent = original; }
  }
}

el('agentSearchBtn').addEventListener('click', function () {
  agentFilters = { search: el('agentSearch').value.trim(), status: el('agentStatusFilter').value };
  renderAgents();
  paintTabAlerts();
});

el('agentRefreshBtn').addEventListener('click', function () {
  el('agentSearch').value = '';
  el('agentStatusFilter').value = 'pending';
  agentFilters = { search: '', status: 'all' };
  loadAgents();
});

el('agentStatusFilter').addEventListener('change', function () {
  agentFilters.status = el('agentStatusFilter').value;
  renderAgents();
  paintTabAlerts();
});

// ============================================================
// CSV
// ============================================================
function csvValue(v) { return '"' + String(v === null || v === undefined ? '' : v).split('"').join('""') + '"'; }
function downloadCsv(headers, rows, prefix) {
  var lines = [headers.map(csvValue).join(',')];
  rows.forEach(function (r) { lines.push(headers.map(function (h) { return csvValue(r[h]); }).join(',')); });
  var blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
  var url = URL.createObjectURL(blob);
  var link = document.createElement('a');
  link.href = url;
  link.download = prefix + '-' + new Date().toISOString().slice(0, 19).split(':').join('-') + '.csv';
  document.body.appendChild(link); link.click(); link.remove();
  URL.revokeObjectURL(url);
}

// ============================================================
// EVENTOS
// ============================================================
el('closeDetailsBtn').addEventListener('click', function () { el('detailsModal').classList.add('hidden'); });
el('closeAccountDetailsBtn').addEventListener('click', function () { el('accountDetailsModal').classList.add('hidden'); });

qsa('.modal-tab').forEach(function (tab) {
  tab.addEventListener('click', function () {
    qsa('.modal-tab').forEach(function (t) { t.classList.remove('active'); });
    qsa('.modal-tab-content').forEach(function (c) { c.classList.remove('active'); });
    tab.classList.add('active');
    el(tab.getAttribute('data-tab')).classList.add('active');
  });
});

// Qual está aberto. O aviso de chat precisa de saber, para se calar
// quando alguém já está a olhar para ele.
// O painel abre nas conversas, não nas reservas.
//
// As reservas consultam-se quando é preciso; uma conversa à espera
// tem de ser vista agora. Abrir no separador errado é começar o
// turno com um clique desperdiçado.
var activeTab = 'chatTab';

/**
 * O que está à espera em cada separador.
 *
 * Um ponto a piscar onde há acção, um número quando o número
 * importa. Só onde há trabalho: se tudo piscasse, nada chamaria a
 * atenção — e o objetivo é exatamente esse, chamar a atenção.
 */
function paintTabAlerts() {
  var set = function (id, count, hot) {
    var badge = el(id);
    if (!badge || badge.__missing) return;

    if (!count) { badge.innerHTML = ''; return; }

    badge.innerHTML = count === true
      ? '<span class="dot' + (hot ? ' hot' : '') + '"></span>'
      : '<span class="count' + (hot ? ' hot' : '') + '">' + count + '</span>';
  };

  var today = todayISO(0);

  // Reservas: as de hoje sem parceiro, e os reembolsos por tratar.
  var noPartner = allBookings.filter(function (b) {
    return !b.assigned_partner_id && b.status !== 'cancelled' && b.booking_date >= today;
  }).length;

  var refunds = allBookings.filter(function (b) {
    var paid = b.charged_at || b.payment_status === 'paid' || b.status === 'paid';
    return b.status === 'cancelled' && paid && !(Number(b.refunded_amount || 0) > 0);
  }).length;

  set('bookingsBadge', noPartner + refunds, refunds > 0);

  /**
   * Motoristas e agências à espera de uma decisão, a vermelho.
   *
   * Estava a false, e por isso o número aparecia em cinzento como
   * qualquer outra contagem. Mas estes são pessoas paradas à espera
   * de alguém — uma candidatura de motorista parada uma semana é um
   * motorista que desiste, e um número cinzento não chama ninguém.
   */
  /**
   * O contador conta os PRONTOS, não os que estão a meio.
   *
   * Contava tudo o que precisava de atenção — incluindo quem ainda
   * não entregou os papéis. Isso dava um número que nunca descia,
   * e um número que nunca desce deixa de ser lido.
   *
   * Os prontos são os que só precisam de um clique. Esses sim
   * devem chamar.
   */
  var ptReady = (typeof partners !== 'undefined'
    ? partners.filter(readyToApprove).length : 0);

  var ptWaiting = (typeof partners !== 'undefined'
    ? partners.filter(needsAction).length : 0);

  set('partnersBadge', ptReady || ptWaiting, ptReady > 0);

  var agWaiting = (typeof agents !== 'undefined'
    ? agents.filter(function (a) { return a.status === 'pending'; }).length : 0);

  set('agentsBadge', agWaiting, agWaiting > 0);

  // Cobranças agendadas e viagens que ninguém pegou.
  set('moneyBadge',
    (typeof charges !== 'undefined' ? charges.length : 0) +
    (typeof unclaimed !== 'undefined' ? unclaimed.length : 0), false);

  // Conversas de cliente por responder. O apoio ao cliente usa outra
  // tabela, e o contador dele já existia com outro nome.
  var waitingSupport = (typeof conversations !== 'undefined')
    ? conversations.filter(function (c) { return c.unread_for_admin > 0; }).length
    : 0;

  set('supportBadge', waitingSupport, waitingSupport > 0);
}

function switchTab(name) {
  var btn = document.querySelector('.tab-btn[data-tab="' + name + '"]');
  if (!btn) return;

  activeTab = name;

  qsa('.tab-btn').forEach(function (b) { b.classList.remove('active'); });
  qsa('.panel').forEach(function (p) { p.classList.remove('active'); });
  btn.classList.add('active');
  el(name).classList.add('active');

  // Abrir o separador é o mesmo que dizer "já vi": o ponto desaparece.
  clearAlerts(name);

  if (name === 'shiftTab') loadShifts();

  if (name === 'chatTab') {
    if (chatAlert) { clearInterval(chatAlert); chatAlert = null; }
    document.title = 'Airportlink operations';
    loadDesk();
  }

  /**
   * A aba de público NÃO se mexe ao mudar de separador.
   *
   * Havia aqui duas linhas a forçá-la: entrar no chatTab punha-a em
   * 'drivers' se estivesse em 'customers'. Foram escritas quando os
   * clientes viviam noutro separador — hoje as três filas partilham
   * o mesmo, e a regra passou a fazer o contrário do que queria.
   *
   * O efeito era este: clicar em Customers mudava a aba, chamava o
   * switchTab, e o switchTab punha-a de volta em Drivers. A vista
   * saltava sozinha e parecia que o clique não tinha funcionado.
   *
   * A escolha é do agente, e vem do servidor. Nada aqui a deve
   * sobrepor.
   */
  pintarAudTabs();

  window.scrollTo({ top: 0, behavior: 'smooth' });
  reportHeight();
}

qsa('.tab-btn').forEach(function (btn) {
  btn.addEventListener('click', function () {
    switchTab(btn.getAttribute('data-tab'));
  });
});

el('searchBtn').addEventListener('click', function () {
  bookingFilters = {
    bookingId: el('searchBookingId').value.trim(),
    email: el('searchEmail').value.trim().toLowerCase(),
    name: el('searchName').value.trim(),
    pickup: el('searchPickup').value.trim(),
    dropoff: el('searchDropoff').value.trim(),
    dateFrom: el('searchDateFrom').value,
    dateTo: el('searchDateTo').value,
    soldFrom: el('searchSoldFrom').value,
    soldTo: el('searchSoldTo').value,
    status: el('searchStatus').value
  };
  loadBookings(bookingFilters);
});

el('clearSearchBtn').addEventListener('click', function () {
  ['searchBookingId','searchEmail','searchName','searchPickup','searchDropoff',
   'searchDateFrom','searchDateTo','searchSoldFrom','searchSoldTo']
    .forEach(function (id) { el(id).value = ''; });
  el('searchStatus').value = '';
  bookingFilters = { bookingId:'', email:'', name:'', pickup:'', dropoff:'',
    dateFrom:'', dateTo:'', soldFrom:'', soldTo:'', status:'' };
  loadBookings(bookingFilters);
});

el('refreshBtn').addEventListener('click', async function () {
  await loadBookings(bookingFilters);
  await loadContacts();
  await loadConversations();
  await loadAgents();
  await loadPartners();
  await loadCharges();
  await loadFinance();
});

el('perPageSelect').addEventListener('change', function (e) {
  bookingPerPage = parseInt(e.target.value, 10); bookingPage = 1;
  renderBookings(); renderBookingPagination();
});
el('contactsPerPageSelect').addEventListener('change', function (e) {
  contactPerPage = parseInt(e.target.value, 10); contactPage = 1;
  renderContacts(); renderContactPagination();
});

el('contactSearchBtn').addEventListener('click', function () {
  contactFilters = { search: el('contactSearch').value.trim(), searchId: el('contactSearchId').value.trim() };
  loadContacts();
});
el('clearContactSearchBtn').addEventListener('click', function () {
  el('contactSearch').value = ''; el('contactSearchId').value = '';
  contactFilters = { search: '', searchId: '' };
  loadContacts();
});

el('exportBookingsBtn').addEventListener('click', function () {
  if (!allBookings.length) return avisar('Heads up', 'No bookings to export.');
  downloadCsv(['booking_id','booking_reference','full_name','email','phone_code','phone_number',
    'passenger_name','passenger_phone','pickup','dropoff','pickup_airport','pickup_city',
    'booking_date','booking_time','flight_number','passengers','preferred_languages',
    'price','currency','status','payment_status','payment_mode','charge_at','charged_at',
    'charge_attempts','last_charge_error','refunded_amount','refunded_at','refund_reason',
    'amount_total','driver_payout','assigned_partner_id','assigned_at','released_count',
    'booked_by','agent_commission_pct','agent_gross_price','notes','created_at'],
    allBookings, 'airportlink-bookings');
});
el('exportContactsBtn').addEventListener('click', function () {
  if (!contacts.length) return avisar('Heads up', 'No accounts to export.');
  downloadCsv(['id','display_id','full_name','email','phone_number','is_admin','created_at'], contacts, 'airportlink-contacts');
});

el('convSendBtn').addEventListener('click', sendAdminReply);
el('convReplyInput').addEventListener('keydown', function (e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendAdminReply(); }
});
el('convReplyInput').addEventListener('input', function () {
  this.style.height = 'auto';
  this.style.height = Math.min(this.scrollHeight, 120) + 'px';
});

el('convToggleStatusBtn').addEventListener('click', async function () {
  var conv = conversations.find(function (c) { return String(c.id) === String(activeConvId); });
  if (!conv) return;
  var newStatus = conv.status === 'resolved' ? 'open' : 'resolved';
  var res = await client.from('support_chats')
    .update({ status: newStatus, updated_at: new Date().toISOString() }).eq('id', activeConvId);
  if (res.error) return avisar('Heads up', res.error.message);
  conv.status = newStatus;
  updateStatusUI(newStatus);
  renderConversationList(); renderConvStats();
});

el('convSearchBtn').addEventListener('click', function () {
  convFilters = {
    search: el('convSearchText').value.trim(),
    status: el('convSearchStatus').value,
    subject: el('convSearchSubject').value
  };
  loadConversations();
});
el('convClearSearchBtn').addEventListener('click', function () {
  el('convSearchText').value = ''; el('convSearchStatus').value = ''; el('convSearchSubject').value = '';
  convFilters = { search: '', status: '', subject: '' };
  loadConversations();
});

async function init() {
  /**
   * A barra de estado primeiro, e sozinha.
   *
   * Estava no fim de sete chamadas em fila — reservas, contactos,
   * conversas, agências, parceiros, cobranças e finanças. Só depois
   * de todas é que o agente via se estava ao serviço.
   *
   * É a informação mais urgente do painel e era a última a chegar.
   * Agora parte primeiro e o resto vai atrás, sem ninguém à espera.
   */
  pintarMarcas();

  var apoio = Promise.all([
    iniciarApoio(),
    loadDesk(),
    carregarDia()
  ]).then(function () {
    arrancarDia();
  });

  /**
   * O resto em paralelo, não em fila.
   *
   * Sete chamadas seguidas somavam sete latências. Em paralelo
   * paga-se uma vez, porque partem juntas — e nenhuma delas depende
   * do resultado da anterior.
   */
  await Promise.all([
    apoio,
    loadBookings(bookingFilters).catch(function (e) { console.error('bookings:', e); }),
    loadContacts().catch(function (e) { console.error('contacts:', e); }),
    loadConversations().catch(function (e) { console.error('conversations:', e); }),
    loadAgents().catch(function (e) { console.error('agents:', e); }),
    loadPartners().catch(function (e) { console.error('partners:', e); }),
    loadCharges().catch(function (e) { console.error('charges:', e); }),
    loadFinance().catch(function (e) { console.error('finance:', e); })
  ]);

  subscribeToAllConversations();
  watchLive();

  // A fila acompanha os outros agentes: por eventos, e por relógio
  // como rede de segurança.
  arrancarFilaPeriodica();
}

(async function boot() {
  el('gateView').classList.add('hidden');
  el('bootView').classList.remove('hidden');

  /**
   * Um limite de tempo à volta do arranque.
   *
   * O verifyAdmin fala com o Supabase três vezes. Se uma dessas
   * chamadas nunca resolver — rede em baixo, chave errada, um
   * projeto pausado — o await fica pendurado para sempre e o
   * painel mostra "a carregar" indefinidamente, sem erro nenhum na
   * consola.
   *
   * Ao fim de doze segundos desistimos e mostramos o ecrã de
   * entrada. Pior do que não conseguir entrar é não perceber que
   * não se está a conseguir.
   */
  var comLimite = function (promessa, ms) {
    return Promise.race([
      promessa,
      new Promise(function (_, rejeitar) {
        setTimeout(function () {
          rejeitar(new Error('Supabase did not answer within ' + (ms / 1000) + ' seconds.'));
        }, ms);
      })
    ]);
  };

  try {
    if (!window.supabase) {
      throw new Error('The Supabase library did not load. Check the network tab.');
    }

    var session = await comLimite(verifyAdmin(), 12000);
    if (session) { await enterAdmin(session); return; }
  } catch (e) {
    console.error('boot error:', e);

    // O erro fica no ecrã, não só na consola. Quem está a olhar
    // para o painel não tem a consola aberta.
    var aviso = el('gateError');
    if (aviso && !aviso.__missing) {
      aviso.textContent = e.message;
      aviso.classList.remove('hidden');
      aviso.style.display = 'block';
    }
  }

  el('bootView').classList.add('hidden');
  el('gateView').classList.remove('hidden');
  reportHeight();
})();
})();
