const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

const TREOLAN_BASE = 'https://b2b.treolan.ru/api/v1';
const LOGIN        = process.env.TREOLAN_LOGIN    || '';
const PASSWORD     = process.env.TREOLAN_PASSWORD || '';
const M3_VENDOR    = process.env.M3_VENDOR_ID     || '0';

// Токен в памяти
let cachedToken  = null;
let tokenExpires = 0;

async function getToken() {
  if (cachedToken && Date.now() < tokenExpires) return cachedToken;

  if (!LOGIN || !PASSWORD) {
    throw new Error('TREOLAN_LOGIN и TREOLAN_PASSWORD не заданы в Variables');
  }

  console.log('🔐 Получаю токен...');

  const authUrls = [
    '/Auth/GetToken',
    '/Auth/Login',
    '/Auth/Token',
    '/Account/GetToken',
    '/Account/Login',
  ];

  let lastError = '';
  for (const path of authUrls) {
    try {
      const res = await fetch(TREOLAN_BASE + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ login: LOGIN, password: PASSWORD })
      });

      const text = await res.text();
      console.log(`${path} → ${res.status}: ${text.slice(0, 100)}`);

      if (res.ok) {
        let data;
        try { data = JSON.parse(text); } catch { continue; }

        const token = data.token || data.accessToken || data.access_token
                   || data.bearerToken || data.jwt || data.result
                   || (typeof data === 'string' ? data : null);

        if (token && typeof token === 'string' && token.length > 10) {
          cachedToken  = token;
          tokenExpires = Date.now() + 55 * 60 * 1000;
          console.log(`✅ Токен получен через ${path}`);
          return token;
        }
      }
      lastError = `${path} → ${res.status}`;
    } catch (e) {
      lastError = `${path} → ${e.message}`;
      console.log(`❌ ${lastError}`);
    }
  }

  throw new Error(`Не удалось получить токен. Последняя попытка: ${lastError}`);
}

async function treolan(method, path, body = null, params = null) {
  const token = await getToken();
  const url = new URL(TREOLAN_BASE + path);
  if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  const options = {
    method,
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
  };
  if (body) options.body = JSON.stringify(body);

  const res = await fetch(url.toString(), options);

  if (res.status === 401) {
    cachedToken = null;
    tokenExpires = 0;
    return treolan(method, path, body, params);
  }

  if (!res.ok) throw new Error(`Treolan ${res.status}: ${await res.text()}`);
  return res.json();
}

app.use(cors({
  origin: [
    'https://m3-mobile.ru',
    'https://www.m3-mobile.ru',
    'http://localhost',
    'http://127.0.0.1'
  ]
}));
app.use(express.json());

// ── Документация
app.get('/', (req, res) => {
  res.json({
    name: 'M3 Mobile × Treolan Proxy',
    version: '3.0',
    status: 'online',
    endpoints: {
      'GET /api/ping':              'Проверка сервера',
      'GET /api/auth-check':        'Проверка авторизации',
      'GET /api/catalog':           'Каталог M3 Mobile',
      'GET /api/catalog?search=X':  'Поиск по артикулу',
      'GET /api/product/:articul':  'Товар + фото + характеристики',
    }
  });
});

// ── Ping (без авторизации)
app.get('/api/ping', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// ── Проверка авторизации
app.get('/api/auth-check', async (req, res) => {
  try {
    const token = await getToken();
    res.json({ status: 'ok', message: 'Авторизация успешна', tokenLength: token.length });
  } catch (e) {
    res.status(401).json({ status: 'error', error: e.message });
  }
});

// ── Каталог
app.get('/api/catalog', async (req, res) => {
  try {
    const { search } = req.query;
    const body = {
      category:  '',
      vendorid:  parseInt(M3_VENDOR),
      keywords:  search || '',
      criterion: 'Contains',
      inArticul: true,
      inName:    true,
      inMark:    false,
      showNc:    1,
      freeNom:   true
    };

    const data = await treolan('POST', '/Catalog/Get', body);

    const items = [];
    function extract(node, catName) {
      const name = node.name || catName || '';
      if (Array.isArray(node.positions)) {
        node.positions.forEach(p => items.push({
          articul:     p.articul         || '',
          name:        p.name            || '',
          category:    name,
          stock:       p.quantity        || 0,
          transit:     p.transitQuantity || 0,
          transitDate: p.transitDate     || null,
          available:   (p.quantity || 0) > 0,
        }));
      }
      if (Array.isArray(node.category)) node.category.forEach(c => extract(c, name));
      if (Array.isArray(node.children)) node.children.forEach(c => extract(c, name));
    }
    (data.categories || data.category || []).forEach(c => extract(c));

    res.json({ total: items.length, updated: new Date().toISOString(), items });

  } catch (e) {
    console.error('Catalog error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Товар
app.get('/api/product/:articul', async (req, res) => {
  try {
    const data = await treolan('GET', '/Catalog/GetProduct', null, { articul: req.params.articul });
    res.json({
      articul:     data.articul         || req.params.articul,
      name:        data.name            || '',
      description: data.description     || '',
      stock:       data.quantity        || 0,
      transit:     data.transitQuantity || 0,
      transitDate: data.transitDate     || null,
      available:   (data.quantity || 0) > 0,
      photos:      extractPhotos(data),
      specs:       extractSpecs(data),
    });
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

function extractPhotos(d) {
  if (Array.isArray(d.images)) return d.images.map(i => i.url || i.src || i).filter(Boolean);
  if (Array.isArray(d.photos)) return d.photos.map(i => i.url || i.src || i).filter(Boolean);
  if (d.imageUrl) return [d.imageUrl];
  if (d.image)    return [d.image];
  return [];
}
function extractSpecs(d) {
  if (Array.isArray(d.properties)) return d.properties.map(p => ({ name: p.name, value: p.value }));
  if (Array.isArray(d.attributes)) return d.attributes.map(p => ({ name: p.name, value: p.value }));
  if (Array.isArray(d.specs))      return d.specs;
  return [];
}

// ── Старт — НЕ падаем если нет логина
app.listen(PORT, () => {
  console.log(`✅ M3 × Treolan Proxy запущен на порту ${PORT}`);
  if (!LOGIN || !PASSWORD) {
    console.log('⚠️  Добавь TREOLAN_LOGIN и TREOLAN_PASSWORD в Variables!');
  }
});
