require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const authRoutes = require('./routes/auth');
const pollsRoutes = require('./routes/polls');

const app = express();

// En-têtes de sécurité HTTP de base (anti-sniffing MIME, anti-clickjacking, cache
// des pages sensibles désactivé, etc.). Le CSP par défaut de Helmet est désactivé
// car voxlive.html utilise massivement des styles et onclick en ligne — l'activer
// tel quel casserait l'affichage. À durcir plus tard si le frontend est réécrit
// sans JS/CSS inline.
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Freine les attaques par force brute sur la connexion/inscription
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30,                  // 30 tentatives / IP / 15 min
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de tentatives, réessaie dans quelques minutes.' },
});

// Freine la création massive de sondages / votes (anti-bot basique)
const pollsLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60,             // 60 requêtes / IP / minute
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de requêtes, ralentis un peu.' },
});

const voxidRoutes = require('./routes/voxid');
app.use('/api/voxid', pollsLimiter, voxidRoutes);
app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/polls', pollsLimiter, pollsRoutes);

app.get('/api/health', (req, res) => res.json({ ok: true }));

// Sert le frontend (voxlive.html renommé en public/index.html) sur la même URL Render
app.use(express.static('public'));

// Repli SPA : toute autre URL (ex. /embed/VXL-XXXXX) sert la même page, qui gère
// elle-même l'affichage embarqué en lisant l'URL côté client.
app.get('*', (req, res) => {
  res.sendFile(require('path').join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`VoxLive API en écoute sur le port ${PORT}`));
