const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// ================================================
//  КОНФИГ — задаётся в Variables на Railway:
//  TREOLAN_LOGIN    = твой логин от Treolan API
//  TREOLAN_PASSWORD = твой пароль от Treolan API
//  M3_VENDOR_ID     = ID M3 Mobile (спроси у Treolan, пока 0 = все)
// ================================================
const TREOLAN_BASE = 'https://b2b.treolan.ru/api/v1';  // боевой сервер
const LOGIN       = process.env.TREOLAN_LOGIN    || '';
const PASSWORD    = process.env.TREOLAN_PASSWORD || '';
const M3_VENDOR   = process.env.M3_VENDOR_ID     || '0';

// ================================================
//  ТОКЕН — хранится в памяти, обновляется сам
// ================================================
let cachedToken   = null;
let tokenExpires  = 0;

async function getToken() {
  // Если токен ещё живой — возвращаем его
  if (cachedToken && Date.now() < tokenExpires) {
    return cachedToken;
  }

  console.log('🔐 Получаю токен от Treolan...');

  // Пробуем разные варианты эндпоинта авторизации
  const authUrls = [
    '/Auth/GetToken',
    '/Auth/Login',
    '/Auth/Token',
    '/Account/Login',
  ];

  for (const path of authUrls) {
    try {
      const res = await fetch(TREOLAN_BASE + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ login: LOGIN, password: PASSWORD })
      });

      if (res.ok) {
        const data = await res.json();
        // Токен может быть в разных полях
        const token = data.token || data.accessToken || data.access_token
                   || data.bearerToken || data.jwt || data.result;

        if (token && typeof token === 'string') {
          cachedToken  = token;
          tokenExpires = Date.now() + 55 * 60 * 1000; // кэш 55 минут
          console.log(`✅ Токен получен через ${path}`);
          return token;
        }
      }
    } catch (e) {
      // пробуем следующий вариант
    }
  }

  throw new Error('Не удалось получить токен. Проверь логин/пароль в Variables.');
}

// ================================================
//  ХЕЛПЕР — запрос к Treolan с авто-авторизацией
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

  // Если токен протух — сбрасываем и повторяем один раз
  if (res.status === 401) {
    console.log('🔄 Токен устарел, обновляю...');
    cachedToken  = null;
    tokenExpires = 0;
    return treolan(method, path, body, params);
  }

  if (!res.ok) throw new Error(`Treolan ${res.status}: ${await res.text()}`);
  return res.json();
}

// ================================================
//  CORS — только твой сайт
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
    name: 'M3 Mobile × Treolan Proxy',
    version: '2.0',
    auth: 'auto (login/password → token)',
    endpoints: {
      'GET /api/ping':               'Проверка сервера',
      'GET /api/catalog':            'Каталог M3 Mobile',
      'GET /api/catalog?search=SL20':'Поиск по артикулу',
      'GET /api/product/:articul':   'Товар + характеристики + фото',
    }
  });
});

// Проверка — работает без авторизации
app.get('/api/ping', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// Проверка авторизации
app.get('/api/auth-check', async (req, res) => {
  try {
    const token = await getToken();
    res.json({ status: 'ok', tokenLength: token.length });
  } catch (e) {
    res.status(401).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────
//  1. КАТАЛОГ — артикул, название, склад, транзит
// ─────────────────────────────────────────────
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

    // Извлекаем позиции из дерева категорий
    const items = [];
    function extract(node, catName) {
      const name = node.name || catName || '';
      if (Array.isArray(node.positions)) {
        node.positions.forEach(p => items.push({
          articul:     p.articul          || '',
          name:        p.name             || '',
          category:    name,
          stock:       p.quantity         || 0,
          transit:     p.transitQuantity  || 0,
          transitDate: p.transitDate      || null,
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
    res.status(500).json({ error: 'Ошибка каталога', detail: e.message });
  }
});

// ─────────────────────────────────────────────
//  2. ТОВАР — характеристики + фото
// ─────────────────────────────────────────────
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
    console.error('Product error:', e.message);
    res.status(404).json({ error: 'Товар не найден', detail: e.message });
  }
});

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
  console.log(`✅ M3 × Treolan Proxy запущен на порту ${PORT}`);
  // Сразу получаем токен при старте
  getToken().catch(e => console.error('⚠️ Авторизация:', e.message));
});
