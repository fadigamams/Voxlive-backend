require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const authRoutes = require('./routes/auth');
const pollsRoutes = require('./routes/polls');

const app = express();

app.use(cors());
app.use(express.json());

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
