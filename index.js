const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// ================================================
//  КОНФИГ — задаётся в Variables на Railway:
//  TREOLAN_TOKEN  = Bearer токен от Treolan
//  M3_VENDOR_ID   = ID производителя M3 Mobile
// ================================================
const TREOLAN_BASE  = 'https://demo-api.treolan.ru/api/v1';
const TREOLAN_TOKEN = process.env.TREOLAN_TOKEN || '';
const M3_VENDOR_ID  = process.env.M3_VENDOR_ID  || '0';

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
//  ХЕЛПЕР — запросы к Treolan
// ================================================
async function treolan(method, path, body = null, params = null) {
  const url = new URL(TREOLAN_BASE + path);
  if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  const options = {
    method,
    headers: {
      'Authorization': `Bearer ${TREOLAN_TOKEN}`,
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
    name: 'M3 Mobile Proxy → Treolan API',
    version: '1.0',
    endpoints: {
      'GET  /api/catalog':             'Каталог M3 Mobile (склад + транзит)',
      'GET  /api/catalog?search=SL20': 'Поиск по артикулу/названию',
      'GET  /api/product/:articul':    'Товар: характеристики + фото',
      'GET  /api/ping':                'Проверка сервера',
    }
  });
});

app.get('/api/ping', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// ─────────────────────────────────────────────
//  1. КАТАЛОГ
//  POST https://demo-api.treolan.ru/api/v1/Catalog/Get
// ─────────────────────────────────────────────
app.get('/api/catalog', async (req, res) => {
  try {
    const { search } = req.query;

    // Точная структура из документации Treolan
    const body = {
      category:  '',
      vendorid:  parseInt(M3_VENDOR_ID), // ID M3 Mobile — уточни у менеджера Treolan
      keywords:  search || '',
      criterion: 'Contains',
      inArticul: true,
      inName:    true,
      inMark:    false,
      showNc:    1,    // 1 = не показывать некондицию
      freeNom:   true  // учитывать свободный товар
    };

    const data = await treolan('POST', '/Catalog/Get', body);

    // Извлекаем позиции из дерева категорий
    const items = [];

    function extractPositions(node, categoryName) {
      const catName = node.name || categoryName || '';

      // Позиции в текущем узле
      if (Array.isArray(node.positions)) {
        node.positions.forEach(p => {
          items.push({
            articul:     p.articul           || '',
            name:        p.name              || '',
            description: p.mark              || '',
            category:    catName,
            stock:       p.quantity          || 0,
            transit:     p.transitQuantity   || 0,
            transitDate: p.transitDate       || null,
            available:   (p.quantity || 0) > 0,
          });
        });
      }

      // Рекурсивно по дочерним категориям
      if (Array.isArray(node.category))  node.category.forEach(c => extractPositions(c, catName));
      if (Array.isArray(node.children))  node.children.forEach(c => extractPositions(c, catName));
    }

    const root = data.categories || data.category || [];
    root.forEach(c => extractPositions(c));

    res.json({
      total:   items.length,
      updated: new Date().toISOString(),
      items
    });

  } catch (e) {
    console.error('Catalog error:', e.message);
    res.status(500).json({ error: 'Ошибка каталога', detail: e.message });
  }
});

// ─────────────────────────────────────────────
//  2. ТОВАР — характеристики + фото
//  GET https://demo-api.treolan.ru/api/v1/Catalog/GetProduct?articul=
// ─────────────────────────────────────────────
app.get('/api/product/:articul', async (req, res) => {
  try {
    const { articul } = req.params;
    const data = await treolan('GET', '/Catalog/GetProduct', null, { articul });

    res.json({
      articul:     data.articul            || articul,
      name:        data.name               || '',
      description: data.description        || data.shortDescription || '',
      stock:       data.quantity           || 0,
      transit:     data.transitQuantity    || 0,
      transitDate: data.transitDate        || null,
      available:   (data.quantity || 0) > 0,
      photos:      extractPhotos(data),
      specs:       extractSpecs(data),
    });

  } catch (e) {
    console.error('Product error:', e.message);
    res.status(404).json({ error: 'Товар не найден', detail: e.message });
  }
});

function extractPhotos(data) {
  if (Array.isArray(data.images))  return data.images.map(i => i.url || i.src || i).filter(Boolean);
  if (Array.isArray(data.photos))  return data.photos.map(i => i.url || i.src || i).filter(Boolean);
  if (data.imageUrl)               return [data.imageUrl];
  if (data.image)                  return [data.image];
  return [];
}

function extractSpecs(data) {
  if (Array.isArray(data.properties))  return data.properties.map(p => ({ name: p.name, value: p.value }));
  if (Array.isArray(data.attributes))  return data.attributes.map(p => ({ name: p.name, value: p.value }));
  if (Array.isArray(data.specs))       return data.specs;
  return [];
}

app.listen(PORT, () => {
  console.log(`✅ M3 × Treolan Proxy на порту ${PORT}`);
});
