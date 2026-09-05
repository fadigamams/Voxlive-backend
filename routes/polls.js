const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = 'VXL-';
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

async function pollWithResults(pollId) {
  const { rows } = await pool.query(
    `SELECT
       p.id, p.code, p.title, p.question, p.category, p.scope, p.status,
       p.created_at, p.user_id,
       u.name AS author_name, u.role AS author_role, u.logo_url AS author_logo,
       COUNT(v.id) FILTER (WHERE v.choice = 'pour')   AS pour_count,
       COUNT(v.id) FILTER (WHERE v.choice = 'contre') AS contre_count
     FROM polls p
     JOIN users u ON u.id = p.user_id
     LEFT JOIN votes v ON v.poll_id = p.id
     WHERE p.id = $1
     GROUP BY p.id, u.name, u.role, u.logo_url`,
    [pollId]
  );
  return rows[0] || null;
}

router.post('/', requireAuth, async (req, res) => {
  try {
    const { title, question, category, scope } = req.body || {};
    if (!title || !title.trim()) {
      return res.status(400).json({ error: 'Le titre est requis.' });
    }
    if (!question || !question.trim()) {
      return res.status(400).json({ error: 'La question est requise.' });
    }

    let code, inserted;
    for (let attempt = 0; attempt < 5 && !inserted; attempt++) {
      code = generateCode();
      try {
        const { rows } = await pool.query(
          `INSERT INTO polls (code, user_id, title, question, category, scope)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id`,
          [code, req.user.sub, title.trim(), question.trim(), category || 'Société', scope || 'nationale']
        );
        inserted = rows[0];
      } catch (err) {
        if (err.code !== '23505') throw err;
      }
    }
    if (!inserted) {
      return res.status(500).json({ error: 'Impossible de générer un code unique, réessaie.' });
    }

    const poll = await pollWithResults(inserted.id);
    res.status(201).json({ poll });
  } catch (err) {
    console.error('Erreur POST /polls :', err);
    res.status(500).json({ error: 'Erreur serveur, réessaie plus tard.' });
  }
});

router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT
         p.id, p.code, p.title, p.question, p.category, p.scope, p.status, p.created_at,
         u.name AS author_name, u.role AS author_role, u.logo_url AS author_logo,
         COUNT(v.id) FILTER (WHERE v.choice = 'pour')   AS pour_count,
         COUNT(v.id) FILTER (WHERE v.choice = 'contre') AS contre_count
       FROM polls p
       JOIN users u ON u.id = p.user_id
       LEFT JOIN votes v ON v.poll_id = p.id
       WHERE p.status = 'active'
       GROUP BY p.id, u.name, u.role, u.logo_url
       ORDER BY p.created_at DESC
       LIMIT 50`
    );
    res.json({ polls: rows });
  } catch (err) {
    console.error('Erreur GET /polls :', err);
    res.status(500).json({ error: 'Erreur serveur, réessaie plus tard.' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const poll = await pollWithResults(req.params.id);
    if (!poll) return res.status(404).json({ error: 'Sondage introuvable.' });
    res.json({ poll });
  } catch (err) {
    console.error('Erreur GET /polls/:id :', err);
    res.status(500).json({ error: 'Erreur serveur, réessaie plus tard.' });
  }
});

router.post('/:id/vote', requireAuth, async (req, res) => {
  try {
    const { choice } = req.body || {};
    if (!['pour', 'contre'].includes(choice)) {
      return res.status(400).json({ error: 'Le choix doit être "pour" ou "contre".' });
    }

    const pollCheck = await pool.query('SELECT status FROM polls WHERE id = $1', [req.params.id]);
    if (!pollCheck.rows[0]) return res.status(404).json({ error: 'Sondage introuvable.' });
    if (pollCheck.rows[0].status !== 'active') {
      return res.status(409).json({ error: 'Ce sondage est fermé, les votes ne sont plus acceptés.' });
    }

    try {
      await pool.query(
        'INSERT INTO votes (poll_id, user_id, choice) VALUES ($1, $2, $3)',
        [req.params.id, req.user.sub, choice]
      );
    } catch (err) {
      if (err.code === '23505') {
        return res.status(409).json({ error: 'Tu as déjà voté sur ce sondage.' });
      }
      throw err;
    }

    const poll = await pollWithResults(req.params.id);
    res.status(201).json({ poll });
  } catch (err) {
    console.error('Erreur POST /polls/:id/vote :', err);
    res.status(500).json({ error: 'Erreur serveur, réessaie plus tard.' });
  }
});

router.get('/:id/voters', requireAuth, async (req, res) => {
  try {
    const pollCheck = await pool.query(
      'SELECT id, user_id FROM polls WHERE id::text = $1 OR code = $1',
      [req.params.id]
    );
    if (!pollCheck.rows[0]) return res.status(404).json({ error: 'Sondage introuvable.' });
    if (pollCheck.rows[0].user_id !== req.user.sub) {
      return res.status(403).json({ error: "Tu n'es pas l'auteur de ce sondage." });
    }
    const pollId = pollCheck.rows[0].id;

    const { rows } = await pool.query(
      `SELECT u.name, u.role, v.choice, v.created_at
       FROM votes v
       JOIN users u ON u.id = v.user_id
       WHERE v.poll_id = $1
       ORDER BY v.created_at DESC`,
      [pollId]
    );
    res.json({ voters: rows });
  } catch (err) {
    console.error('Erreur GET /polls/:id/voters :', err);
    res.status(500).json({ error: 'Erreur serveur, réessaie plus tard.' });
  }
});

router.post('/:id/close', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT user_id FROM polls WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Sondage introuvable.' });
    if (rows[0].user_id !== req.user.sub) {
      return res.status(403).json({ error: "Tu n'es pas l'auteur de ce sondage." });
    }
    await pool.query("UPDATE polls SET status = 'closed' WHERE id = $1", [req.params.id]);
    const poll = await pollWithResults(req.params.id);
    res.json({ poll });
  } catch (err) {
    console.error('Erreur POST /polls/:id/close :', err);
    res.status(500).json({ error: 'Erreur serveur, réessaie plus tard.' });
  }
});

module.exports = router;
