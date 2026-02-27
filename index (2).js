const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

const TREOLAN_BASE = 'https://api.treolan.ru/api/v1';
const LOGIN        = process.env.TREOLAN_LOGIN    || '';
const PASSWORD     = process.env.TREOLAN_PASSWORD || '';
const M3_VENDOR    = parseInt(process.env.M3_VENDOR_ID || '746'); // M3 Mobile vendorId

let cachedToken  = null;
let tokenExpires = 0;

async function getToken() {
  if (cachedToken && Date.now() < tokenExpires) return cachedToken;
  if (!LOGIN || !PASSWORD) throw new Error('TREOLAN_LOGIN и TREOLAN_PASSWORD не заданы');

  const res  = await fetch(`${TREOLAN_BASE}/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: LOGIN, password: PASSWORD })
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Ошибка авторизации ${res.status}: ${text}`);

  let token;
  try {
    const data = JSON.parse(text);
    token = data.token || data.accessToken || data.access_token || data.result;
  } catch {
    token = text.trim().replace(/^"|"$/g, '');
  }

  if (!token || token.length < 10) throw new Error('Токен не найден: ' + text);
  cachedToken  = token;
  tokenExpires = Date.now() + 55 * 60 * 1000;
  console.log('✅ Токен получен');
  return token;
}

async function treolan(method, path, body = null, params = null) {
  const token = await getToken();
  const url   = new URL(TREOLAN_BASE + path);
  if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  const options = {
    method,
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
  };
  if (body) options.body = JSON.stringify(body);

  const res = await fetch(url.toString(), options);
  if (res.status === 401) { cachedToken = null; tokenExpires = 0; return treolan(method, path, body, params); }
  if (!res.ok) throw new Error(`Treolan ${res.status}: ${await res.text()}`);
  return res.json();
}

app.use(cors({
  origin: ['https://m3-mobile.ru', 'https://www.m3-mobile.ru', 'https://m3mobilerus-crypto.github.io', 'http://localhost', 'http://127.0.0.1']
}));
app.use(express.json());

app.get('/', (req, res) => {
  res.json({
    name: 'M3 Mobile × Treolan Proxy', version: '6.0',
    vendorId: M3_VENDOR,
    endpoints: {
      'GET /api/ping':             'Проверка',
      'GET /api/auth-check':       'Проверка авторизации',
      'GET /api/myip':             'IP сервера',
      'GET /api/catalog':          'Каталог M3 Mobile',
      'GET /api/catalog?search=X': 'Поиск по артикулу/названию',
      'GET /api/product/:articul': 'Товар + фото + характеристики',
    }
  });
});

app.get('/api/ping', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

app.get('/api/myip', async (req, res) => {
  try {
    const r = await fetch('https://api.ipify.org?format=json');
    res.json({ ...(await r.json()), note: 'Этот IP нужно передать в Treolan для whitelist' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/auth-check', async (req, res) => {
  try {
    const token = await getToken();
    res.json({ status: 'ok', message: 'Авторизация успешна!', tokenLength: token.length });
  } catch (e) { res.status(401).json({ status: 'error', error: e.message }); }
});

// ─────────────────────────────────────────────
//  КАТАЛОГ — правильная структура Treolan
//  categories → children → products[]
// ─────────────────────────────────────────────
app.get('/api/catalog', async (req, res) => {
  try {
    const { search } = req.query;

    const data = await treolan('POST', '/Catalog/Get', {
      category:  '',
      vendorid:  M3_VENDOR,
      keywords:  search || '',
      criterion: 'Contains',
      inArticul: true,
      inName:    true,
      inMark:    false,
      showNc:    1,
      freeNom:   true
    });

    const items = [];

    function extractProducts(node, catName) {
      const name = node.name || catName || '';

      // Товары в products[]
      if (Array.isArray(node.products)) {
        node.products.forEach(p => {
          if (p.vendor !== 'M3 Mobile' && M3_VENDOR !== 0) return; // фильтр по бренду
          items.push({
            articul:     p.articul          || '',
            name:        p.rusName          || p.description || '',
            description: p.description      || '',
            category:    name,
            stock:       parseStock(p.atStock),
            transit:     parseStock(p.atTransit),
            transitDate: p.nearestDeliveryDate || null,
            available:   parseStock(p.atStock) > 0,
            vendor:      p.vendor           || 'M3 Mobile',
          });
        });
      }

      // Рекурсивно по children
      if (Array.isArray(node.children)) node.children.forEach(c => extractProducts(c, name));
    }

    (data.categories || []).forEach(c => extractProducts(c));

    res.json({ total: items.length, updated: new Date().toISOString(), items });

  } catch (e) {
    console.error('Catalog error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────
//  ТОВАР — характеристики + фото
// ─────────────────────────────────────────────
app.get('/api/product/:articul', async (req, res) => {
  try {
    const data = await treolan('GET', '/Catalog/GetProduct', null, { articul: req.params.articul });
    res.json({
      articul:     data.articul              || req.params.articul,
      name:        data.rusName              || data.description || '',
      description: data.description          || '',
      stock:       parseStock(data.atStock),
      transit:     parseStock(data.atTransit),
      transitDate: data.nearestDeliveryDate  || null,
      available:   parseStock(data.atStock) > 0,
      photos:      extractPhotos(data),
      specs:       extractSpecs(data),
    });
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────
//  ХЕЛПЕРЫ
// ─────────────────────────────────────────────
function parseStock(val) {
  if (typeof val === 'number') return val;
  if (val === 'много' || val === 'many') return 999;
  const n = parseInt(val);
  return isNaN(n) ? 0 : n;
}

function extractPhotos(d) {
  if (Array.isArray(d.images))  return d.images.map(i => i.url || i.src || i).filter(Boolean);
  if (Array.isArray(d.photos))  return d.photos.map(i => i.url || i.src || i).filter(Boolean);
  if (d.imageUrl) return [d.imageUrl];
  if (d.image)    return [d.image];
  return [];
}

function extractSpecs(d) {
  if (Array.isArray(d.properties))  return d.properties.map(p => ({ name: p.name, value: p.value }));
  if (Array.isArray(d.attributes))  return d.attributes.map(p => ({ name: p.name, value: p.value }));
  if (Array.isArray(d.specs))       return d.specs;
  return [];
}

app.listen(PORT, () => {
  console.log(`✅ M3 × Treolan Proxy v6 запущен на порту ${PORT}`);
  console.log(`🏷  vendorId M3 Mobile: ${M3_VENDOR}`);
});
