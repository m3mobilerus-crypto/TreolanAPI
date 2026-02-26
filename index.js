const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// ================================================
//  КОНФИГ — Variables на Railway:
//  TREOLAN_LOGIN    = твой логин
//  TREOLAN_PASSWORD = твой пароль
//  M3_VENDOR_ID     = ID M3 Mobile (уточни у Treolan, пока 0)
// ================================================
const TREOLAN_BASE = 'https://api.treolan.ru/api/v1';
const LOGIN        = process.env.TREOLAN_LOGIN    || '';
const PASSWORD     = process.env.TREOLAN_PASSWORD || '';
const M3_VENDOR    = process.env.M3_VENDOR_ID     || '0';

// Токен в памяти
let cachedToken  = null;
let tokenExpires = 0;

// ================================================
//  АВТОРИЗАЦИЯ — POST /auth/token
// ================================================
async function getToken() {
  if (cachedToken && Date.now() < tokenExpires) return cachedToken;

  if (!LOGIN || !PASSWORD) throw new Error('TREOLAN_LOGIN и TREOLAN_PASSWORD не заданы в Variables');

  console.log('🔐 Получаю токен...');

  const res = await fetch(`${TREOLAN_BASE}/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: LOGIN, password: PASSWORD })
  });

  const text = await res.text();
  console.log(`/auth/token → ${res.status}: ${text.slice(0, 200)}`);

  if (!res.ok) throw new Error(`Ошибка авторизации ${res.status}: ${text}`);

  // Treolan может вернуть токен как plain text или как JSON
  let token = null;
  try {
    const data = JSON.parse(text);
    token = data.token || data.accessToken || data.access_token
          || data.bearerToken || data.jwt || data.result
          || (typeof data === 'string' ? data : null);
  } catch {
    // Ответ — plain text, это и есть токен
    token = text.trim().replace(/^"|"$/g, ''); // убираем кавычки если есть
  }

  if (!token || token.length < 10) throw new Error('Токен не найден в ответе: ' + text);

  cachedToken  = token;
  tokenExpires = Date.now() + 55 * 60 * 1000; // 55 минут
  console.log('✅ Токен получен!');
  return token;
}

// ================================================
//  ХЕЛПЕР — запрос к Treolan
// ================================================
async function treolan(method, path, body = null, params = null) {
  const token = await getToken();
  const url = new URL(TREOLAN_BASE + path);
  if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  const options = {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    }
  };
  if (body) options.body = JSON.stringify(body);

  const res = await fetch(url.toString(), options);

  if (res.status === 401) {
    console.log('🔄 Токен устарел, обновляю...');
    cachedToken = null;
    tokenExpires = 0;
    return treolan(method, path, body, params);
  }

  if (!res.ok) throw new Error(`Treolan ${res.status}: ${await res.text()}`);
  return res.json();
}

// ================================================
//  CORS
// ================================================
app.use(cors({
  origin: [
    'https://m3-mobile.ru',
    'https://www.m3-mobile.ru',
    'http://localhost',
    'http://127.0.0.1'
  ]
}));
app.use(express.json());

// ================================================
//  ЭНДПОИНТЫ
// ================================================

app.get('/', (req, res) => {
  res.json({
    name:    'M3 Mobile × Treolan Proxy',
    version: '5.0',
    status:  'online',
    auth:    'auto via /auth/token',
    endpoints: {
      'GET /api/ping':             'Проверка сервера',
      'GET /api/auth-check':       'Проверка авторизации',
      'GET /api/myip':             'IP сервера (для Treolan)',
      'GET /api/catalog':          'Каталог M3 Mobile',
      'GET /api/catalog?search=X': 'Поиск по артикулу',
      'GET /api/product/:articul': 'Товар + фото + характеристики',
    }
  });
});

app.get('/api/ping', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// IP сервера для whitelist Treolan
app.get('/api/myip', async (req, res) => {
  try {
    const r = await fetch('https://api.ipify.org?format=json');
    const data = await r.json();
    res.json({ ip: data.ip, note: 'Этот IP нужно передать в Treolan для whitelist' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Проверка авторизации
app.get('/api/auth-check', async (req, res) => {
  try {
    const token = await getToken();
    res.json({ status: 'ok', message: 'Авторизация успешна!', tokenLength: token.length });
  } catch (e) {
    res.status(401).json({ status: 'error', error: e.message });
  }
});

// ── Каталог M3 Mobile
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

// ── Товар с характеристиками и фото
app.get('/api/product/:articul', async (req, res) => {
  try {
    const data = await treolan('GET', '/Catalog/GetProduct', null, {
      articul: req.params.articul
    });
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

app.listen(PORT, () => {
  console.log(`✅ M3 × Treolan Proxy v5 запущен на порту ${PORT}`);
  console.log(LOGIN ? `👤 Логин: ${LOGIN}` : '⚠️  TREOLAN_LOGIN не задан!');
});
