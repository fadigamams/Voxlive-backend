require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const authRoutes = require('./routes/auth');
const pollsRoutes = require('./routes/polls');

const app = express();

app.use(cors());
app.use(express.json());

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de tentatives, réessaie dans quelques minutes.' },
});

const pollsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de requêtes, ralentis un peu.' },
});

app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/polls', pollsLimiter, pollsRoutes);

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.use(express.static('public'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`VoxLive API en écoute sur le port ${PORT}`));
