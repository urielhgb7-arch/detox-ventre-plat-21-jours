const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const fs = require('fs');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Stockage persistant léger JSON pour les commandes et l'idempotence
const DB_FILE = path.join(__dirname, 'orders_db.json');
let ordersDB = {};

if (fs.existsSync(DB_FILE)) {
  try {
    ordersDB = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (e) {
    ordersDB = {};
  }
}

function saveDB() {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(ordersDB, null, 2), 'utf8');
  } catch (err) {
    console.error('Erreur sauvegarde base de données:', err.message);
  }
}

// Fonction de hachage SHA-256 pour Meta CAPI (minuscules normalisées trim)
function hashMetaField(value) {
  if (!value) return '';
  const normalized = String(value).trim().toLowerCase();
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

// Signature HMAC pour sécuriser les redirections du Sas
function generateHmacSignature(orderId) {
  return crypto
    .createHmac('sha256', process.env.ORDER_HMAC_SECRET || 'maketou_andromeda_hmac_secret_2026_x99')
    .update(orderId)
    .digest('hex');
}

function verifyHmacSignature(orderId, sig) {
  if (!orderId || !sig) return false;
  try {
    const expected = generateHmacSignature(orderId);
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
  } catch (e) {
    return false;
  }
}

function formatAfricanPhone(rawPhone) {
  let cleaned = String(rawPhone || '').replace(/[^0-9]/g, '');
  if (cleaned.startsWith('229')) {
    let national = cleaned.slice(3);
    if (national.length === 9 && national.startsWith('1')) {
      national = '0' + national;
    }
    return '+229' + national;
  }
  if (cleaned.startsWith('225')) {
    let national = cleaned.slice(3);
    if (national.length === 9) {
      national = '0' + national;
    }
    return '+225' + national;
  }
  return '+' + cleaned;
}

// ============================================================================
// ENDPOINT 1 : CRÉATION DU CHECKOUT MAKETOU RÉEL (ZÉRO MOCK, SANS CUSTOMERPRICE)
// ============================================================================
app.post('/api/checkout/create', async (req, res) => {
  try {
    const { fullName, email, phone, fbp, fbc } = req.body;
    const productDocumentId = process.env.PRODUCT_DOCUMENT_ID || '57b7e371-6c0c-4262-bc58-e4cfe48da606';

    if (!fullName || !email || !phone) {
      return res.status(400).json({ error: 'Champs obligatoires manquants (Nom, Email, Téléphone).' });
    }

    // 1. Découpage automatique et inratable du Nom Complet en firstName + lastName
    const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
    const firstName = parts[0] || 'Client';
    const lastName = parts.slice(1).join(' ') || 'Acheteur';

    // 2. Nettoyage strict et normalisation du téléphone au format international (+[chiffres])
    let cleanPhone = formatAfricanPhone(phone);
    const cleanEmail = String(email || '').trim().toLowerCase();

    // 3. Verrou 1 : Idempotence à la création (fenêtre 10 min)
    const timeWindow = Math.floor(Date.now() / (10 * 60 * 1000));
    const idempotencyHash = crypto
      .createHash('sha256')
      .update(`${productDocumentId}_${cleanEmail}_${cleanPhone}_${timeWindow}`)
      .digest('hex');

    // Si une commande identique existe déjà, renvoyer la même sans dupliquer
    const existingOrder = Object.values(ordersDB).find(o => o.idempotencyHash === idempotencyHash);
    if (existingOrder && existingOrder.redirectUrl) {
      console.log(`[Idempotence] Commande réutilisée : ${existingOrder.orderId}`);
      return res.json({
        cartId: existingOrder.cartId,
        redirectUrl: existingOrder.redirectUrl,
        orderId: existingOrder.orderId,
        sig: generateHmacSignature(existingOrder.orderId),
        cached: true
      });
    }

    // 4. Construction d'une redirectURL HTTPS 100 % valide (Maketou exige du HTTPS valide)
    const orderId = 'ORD_' + crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    const sig = generateHmacSignature(orderId);
    const baseUrl = process.env.APP_BASE_URL || '';
    const isPublicHttps = baseUrl.startsWith('https://') && !baseUrl.includes('votre-domaine') && !baseUrl.includes('localhost');
    
    const redirectURL = isPublicHttps
      ? `${baseUrl.replace(/\/$/, '')}/verify-purchase?orderId=${orderId}&sig=${sig}`
      : (process.env.MAKETOU_DOWNLOAD_REDIRECT_URL || 'https://vouh-digital-shop-0.mymaketou.shop/fr/my-purchases');

    // 5. Payload strict Maketou : SANS customerPrice (réservé aux prix libres, erreur 422 sur prix fixe)
    const payload = {
      productDocumentId,
      email: cleanEmail,
      firstName,
      lastName,
      phone: cleanPhone,
      redirectURL,
      meta: {
        internalOrderId: String(orderId),
        productSlug: 'detox-21-jours',
        amountXOF: String(process.env.PRODUCT_PRICE_XOF || '2500'),
        fbp: fbp || '',
        fbc: fbc || ''
      }
    };

    if (isPublicHttps) {
      payload.webhookUrl = `${baseUrl.replace(/\/$/, '')}/api/webhooks/maketou`;
    }

    // 6. Appel réel et direct à l'API officielle Maketou
    console.log('[Maketou API] Envoi du panier vers POST /api/v1/stores/cart/checkout...');
    const maketouRes = await axios.post(
      `${process.env.MAKETOU_API_BASE_URL || 'https://api.maketou.net'}/api/v1/stores/cart/checkout`,
      payload,
      {
        headers: {
          'Authorization': `Bearer ${process.env.MAKETOU_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 15000
      }
    );

    const data = maketouRes.data;
    const cart = data.cart || {};
    const redirectUrl = data.redirectUrl;

    if (!redirectUrl) {
      console.error('[Maketou API Error] Aucune redirectUrl retournée:', data);
      return res.status(400).json({ error: 'Erreur Maketou : pas d’URL de paiement retournée', details: data });
    }

    console.log(`[Maketou API] Succès : redirectUrl reçue (${redirectUrl})`);

    // 7. Enregistrement en base locale
    ordersDB[orderId] = {
      orderId,
      cartId: cart.id || '',
      idempotencyHash,
      email: cleanEmail,
      phone: cleanPhone,
      firstName,
      lastName,
      amount: parseInt(process.env.PRODUCT_PRICE_XOF || '2500', 10),
      currency: 'XOF',
      status: cart.status || 'waiting_payment',
      redirectUrl: redirectUrl,
      purchase_tracked: 0,
      createdAt: new Date().toISOString(),
      fbp: fbp || '',
      fbc: fbc || '',
      clientIp: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
      clientUserAgent: req.headers['user-agent']
    };
    saveDB();

    return res.status(200).json({
      cartId: cart.id,
      redirectUrl: redirectUrl,
      orderId: orderId,
      sig: sig
    });
  } catch (err) {
    const status = err.response?.status || 500;
    const errorDetails = err.response?.data || err.message;
    console.error(`[Checkout Exception ${status}]`, errorDetails);
    return res.status(status).json({
      error: 'Erreur lors de la création du panier Maketou.',
      details: errorDetails
    });
  }
});

// ============================================================================
// ENDPOINT 2 : ÉTAT DU PANIER VIA L'API MAKETOU (VERROU 2)
// ============================================================================
app.get('/api/order/status', async (req, res) => {
  const { orderId, sig } = req.query;

  if (!orderId || !sig || !verifyHmacSignature(orderId, sig)) {
    return res.status(403).json({ error: 'Signature de sécurité HMAC invalide ou manquante.' });
  }

  const order = ordersDB[orderId];
  if (!order) {
    return res.status(404).json({ error: 'Commande introuvable.' });
  }

  if (order.status === 'completed') {
    return res.json({
      success: true,
      status: 'completed',
      purchase_tracked: order.purchase_tracked,
      downloadUrl: process.env.MAKETOU_DOWNLOAD_REDIRECT_URL || 'https://vouh-digital-shop-0.mymaketou.shop/fr/my-purchases',
      cartId: order.cartId,
      orderId: order.orderId
    });
  }

  // Interrogation de l'API Maketou
  if (order.cartId) {
    try {
      const checkRes = await axios.get(
        `${process.env.MAKETOU_API_BASE_URL || 'https://api.maketou.net'}/api/v1/stores/cart/${order.cartId}`,
        {
          headers: {
            'Authorization': `Bearer ${process.env.MAKETOU_API_KEY}`,
            'Content-Type': 'application/json'
          },
          timeout: 8000
        }
      );

      const updatedCart = checkRes.data.cart || checkRes.data;
      if (updatedCart && updatedCart.status) {
        order.status = updatedCart.status;
        saveDB();
      }
    } catch (err) {
      if (err.response?.status === 429) {
        console.warn('Maketou Rate limit (429) atteint, maintien du cache local.');
      } else {
        console.warn('Erreur statut panier Maketou:', err.message);
      }
    }
  }

  return res.json({
    success: true,
    status: order.status,
    purchase_tracked: order.purchase_tracked,
    downloadUrl: process.env.MAKETOU_DOWNLOAD_REDIRECT_URL || 'https://vouh-digital-shop-0.mymaketou.shop/fr/my-purchases',
    cartId: order.cartId,
    orderId: order.orderId,
    redirectUrl: order.redirectUrl
  });
});

// ============================================================================
// ENDPOINT 3 : SIGNAL UNIQUE PURCHASE (PIXEL + META CAPI V21 - VERROU 3)
// ============================================================================
app.post('/api/order/confirm-tracking', async (req, res) => {
  const { orderId, sig } = req.body;

  if (!orderId || !sig || !verifyHmacSignature(orderId, sig)) {
    return res.status(403).json({ error: 'Signature HMAC invalide.' });
  }

  const order = ordersDB[orderId];
  if (!order) {
    return res.status(404).json({ error: 'Commande inconnue.' });
  }

  if (order.status !== 'completed') {
    return res.status(400).json({
      error: 'Le paiement n’est pas encore validé.',
      status: order.status
    });
  }

  // Déduplication absolue : si déjà tracké, on ne renvoie rien
  if (order.purchase_tracked === 1) {
    return res.json({
      success: true,
      alreadyTracked: true,
      message: 'Événement Purchase déjà enregistré (Déduplication active).'
    });
  }

  // Verrou atomique immédiat
  order.purchase_tracked = 1;
  saveDB();

  const eventId = `pur_${order.cartId || order.orderId}`;
  const capiPayload = {
    data: [
      {
        event_name: 'Purchase',
        event_time: Math.floor(Date.now() / 1000),
        event_id: eventId,
        event_source_url: `${process.env.APP_BASE_URL || ''}/verify-purchase?orderId=${order.orderId}&sig=${sig}`,
        action_source: 'website',
        user_data: {
          em: [hashMetaField(order.email)],
          ph: [hashMetaField(order.phone)],
          fn: [hashMetaField(order.firstName)],
          ln: [hashMetaField(order.lastName)],
          client_ip_address: order.clientIp || req.headers['x-forwarded-for'] || req.socket.remoteAddress,
          client_user_agent: order.clientUserAgent || req.headers['user-agent'],
          fbp: order.fbp || undefined,
          fbc: order.fbc || undefined
        },
        custom_data: {
          currency: 'XOF',
          value: order.amount,
          content_name: 'Programme Détox & Ventre Plat en 21 Jours',
          content_ids: [process.env.PRODUCT_DOCUMENT_ID || '57b7e371-6c0c-4262-bc58-e4cfe48da606'],
          content_type: 'product',
          num_items: 1
        }
      }
    ]
  };

  try {
    const metaGraphUrl = `https://graph.facebook.com/${process.env.META_GRAPH_API_VERSION || 'v21.0'}/${process.env.META_PIXEL_ID}/events?access_token=${process.env.META_CAPI_ACCESS_TOKEN}`;
    await axios.post(metaGraphUrl, capiPayload, { headers: { 'Content-Type': 'application/json' }, timeout: 8000 });
    console.log(`[Meta CAPI v21] Événement Purchase envoyé avec succès (${eventId})`);
  } catch (capiError) {
    console.warn('[Meta CAPI Warning]', capiError.response?.data?.error?.message || capiError.message);
  }

  return res.json({
    success: true,
    eventId: eventId,
    shouldFireBrowserPixel: true
  });
});

// ============================================================================
// ROUTE DE TEST / SIMULATION LOCALE (TEST 4 DU PROTOCOLE)
// ============================================================================
app.post('/api/test/simulate-completed', (req, res) => {
  const { orderId } = req.body;
  if (!orderId || !ordersDB[orderId]) {
    return res.status(404).json({ error: 'Commande introuvable' });
  }
  ordersDB[orderId].status = 'completed';
  saveDB();
  return res.json({ success: true, message: `Commande ${orderId} marquée completed pour test.` });
});

// Webhook Maketou
app.post('/api/webhooks/maketou', (req, res) => {
  const event = req.body;
  const cart = event.cart || event.data?.cart;

  if (cart && cart.id) {
    const order = Object.values(ordersDB).find(o => o.cartId === cart.id);
    if (order && cart.status) {
      order.status = cart.status;
      saveDB();
    }
  }
  return res.status(200).json({ received: true });
});

// Pages HTML
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/verify-purchase', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'verify-purchase.html'));
});

app.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`🚀 Tunnel Détox 21 Jours en ligne sur le port ${PORT}`);
  console.log(`🌐 Accès local : http://localhost:${PORT}`);
  console.log(`📦 Produit ID : ${process.env.PRODUCT_DOCUMENT_ID || '57b7e371-6c0c-4262-bc58-e4cfe48da606'}`);
  console.log(`💰 Tarif promo : 2 500 FCFA (au lieu de 10 000 FCFA, -75 %)`);
  console.log(`🔒 Zéro emoji hors témoignages & API Maketou connectée`);
  console.log(`=======================================================`);
});
