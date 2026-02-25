const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// ================================================
//  КОНФИГ — задаётся в Variables на Railway:
//
//  TREOLAN_TOKEN = Bearer токен из Postman коллекции
//  M3_VENDOR_ID  = ID производителя M3 Mobile (0 = все)
// ================================================
const TREOLAN_BASE = 'https://b2b.treolan.ru/api/v1';
const TOKEN        = process.env.TREOLAN_TOKEN || '';
const M3_VENDOR    = process.env.M3_VENDOR_ID  || '0';

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
//  ХЕЛПЕР — запрос к Treolan
// ================================================
async function treolan(method, path, body = null, params = null) {
  if (!TOKEN) throw new Error('TREOLAN_TOKEN не задан в Variables');

  const url = new URL(TREOLAN_BASE + path);
  if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  const options = {
    method,
    headers: {
      'Authorization': `Bearer ${TOKEN}`,
      'Content-Type': 'application/json'
    }
  };
  if (body) options.body = JSON.stringify(body);

  const res = await fetch(url.toString(), options);
  if (!res.ok) throw new Error(`Treolan ${res.status}: ${await res.text()}`);
  return res.json();
}

// ================================================
//  ЭНДПОИНТЫ
// ================================================

app.get('/', (req, res) => {
  res.json({
    name:    'M3 Mobile × Treolan Proxy',
    version: '4.0',
    status:  'online',
    token:   TOKEN ? `задан (${TOKEN.length} символов)` : '❌ НЕ ЗАДАН — добавь в Variables',
    endpoints: {
      'GET /api/ping':             'Проверка сервера',
      'GET /api/auth-check':       'Проверка токена',
      'GET /api/catalog':          'Каталог M3 Mobile',
      'GET /api/catalog?search=X': 'Поиск по артикулу',
      'GET /api/product/:articul': 'Товар + фото + характеристики',
    }
  });
});

app.get('/api/ping', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

app.get('/api/auth-check', async (req, res) => {
  if (!TOKEN) {
    return res.status(401).json({
      status: 'error',
      error: 'TREOLAN_TOKEN не задан',
      fix: 'Railway → TreolanAPI → Variables → добавь TREOLAN_TOKEN'
    });
  }
  // Проверяем токен лёгким запросом
  try {
    await treolan('GET', '/Catalog/GetCategories');
    res.json({ status: 'ok', message: 'Токен работает!' });
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
  console.log(`✅ M3 × Treolan Proxy запущен на порту ${PORT}`);
  console.log(TOKEN ? `🔑 Токен задан (${TOKEN.length} символов)` : '⚠️  TREOLAN_TOKEN не задан!');
});
