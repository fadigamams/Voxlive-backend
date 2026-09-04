const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
const ALLOWED_ROLES = ['particulier', 'influenceur', 'tv', 'entreprise'];

function signToken(user) {
  return jwt.sign(
    { sub: user.id, name: user.name, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: '30d' }
  );
}

function publicUser(row) {
  const { password_hash, ...safe } = row;
  return safe;
}

router.post('/register', async (req, res) => {
  try {
    const { name, email, phone, password, role } = req.body || {};

    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Le nom du compte est requis.' });
    }
    if (!email && !phone) {
      return res.status(400).json({ error: 'Un email ou un numéro de téléphone est requis.' });
    }
    if (!password || password.length < 6) {
      return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 6 caractères.' });
    }

    const finalRole = ALLOWED_ROLES.includes(role) ? role : 'particulier';

    const existing = await pool.query(
      'SELECT id FROM users WHERE email = $1 OR phone = $2',
      [email?.trim() || null, phone?.trim() || null]
    );
    if (existing.rows.length) {
      return res.status(409).json({ error: 'Un compte existe déjà avec cet email ou ce numéro.' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      `INSERT INTO users (name, email, phone, password_hash, role)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, email, phone, role, logo_url, vox_score, verified, created_at, password_hash`,
      [name.trim(), email?.trim() || null, phone?.trim() || null, passwordHash, finalRole]
    );

    const user = rows[0];
    const token = signToken(user);
    res.status(201).json({ user: publicUser(user), token });
  } catch (err) {
    console.error('Erreur /register :', err);
    res.status(500).json({ error: 'Erreur serveur, réessaie plus tard.' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { identifier, password } = req.body || {};
    if (!identifier || !password) {
      return res.status(400).json({ error: 'Identifiant et mot de passe requis.' });
    }

    const { rows } = await pool.query(
      'SELECT * FROM users WHERE email = $1 OR phone = $1',
      [identifier.trim()]
    );
    const user = rows[0];
    if (!user) {
      return res.status(401).json({ error: 'Identifiants incorrects.' });
    }

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      return res.status(401).json({ error: 'Identifiants incorrects.' });
    }

    const token = signToken(user);
    res.json({ user: publicUser(user), token });
  } catch (err) {
    console.error('Erreur /login :', err);
    res.status(500).json({ error: 'Erreur serveur, réessaie plus tard.' });
  }
});

router.get('/me', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, email, phone, role, logo_url, vox_score, verified, created_at
       FROM users WHERE id = $1`,
      [req.user.sub]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Compte introuvable.' });
    res.json({ user: rows[0] });
  } catch (err) {
    console.error('Erreur /me :', err);
    res.status(500).json({ error: 'Erreur serveur, réessaie plus tard.' });
  }
});

router.patch('/me/logo', requireAuth, async (req, res) => {
  try {
    const { logo_data_url } = req.body || {};
    if (!logo_data_url || !/^data:image\/(png|jpe?g|webp|gif|svg\+xml);base64,/.test(logo_data_url)) {
      return res.status(400).json({ error: 'Logo invalide — image PNG/JPG/WebP/GIF/SVG requise.' });
    }
    if (logo_data_url.length > 1_400_000) {
      return res.status(400).json({ error: 'Logo trop volumineux (1 Mo maximum).' });
    }

    const { rows } = await pool.query(
      `UPDATE users SET logo_url = $1 WHERE id = $2
       RETURNING id, name, email, phone, role, logo_url, vox_score, verified, created_at`,
      [logo_data_url, req.user.sub]
    );
    res.json({ user: rows[0] });
  } catch (err) {
    console.error('Erreur PATCH /me/logo :', err);
    res.status(500).json({ error: 'Erreur serveur, réessaie plus tard.' });
  }
});

module.exports = router;
