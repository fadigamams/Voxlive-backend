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
       p.poll_type, p.security_level, p.closes_at, p.runoff_of,
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
  const poll = rows[0];
  if (!poll) return null;

  await maybeAutoClose(poll);

  if (poll.poll_type === 'multi') {
    const { rows: options } = await pool.query(
      `SELECT o.id, o.label, o.photo_url, o.display_order,
              COUNT(v.id)::int AS votes
       FROM poll_options o
       LEFT JOIN votes v ON v.option_id = o.id
       WHERE o.poll_id = $1
       GROUP BY o.id
       ORDER BY o.display_order ASC, o.created_at ASC`,
      [pollId]
    );
    const totalVotes = options.reduce((sum, o) => sum + o.votes, 0);
    const sorted = [...options].sort((a, b) => b.votes - a.votes);
    let rank = 0, prevVotes = null;
    const ranked = sorted.map((o, i) => {
      if (o.votes !== prevVotes) { rank = i + 1; prevVotes = o.votes; }
      return { ...o, rank, percent: totalVotes ? Math.round((o.votes / totalVotes) * 1000) / 10 : 0 };
    });
    poll.options = ranked;
    poll.total_votes = totalVotes;
    if (poll.status === 'closed') {
      const topScore = ranked[0]?.votes ?? 0;
      const winners = ranked.filter(o => o.votes === topScore && topScore > 0);
      poll.winner = winners.length === 1 ? winners[0] : null;
      poll.tie = winners.length > 1 ? winners : null;
    }
  }
  return poll;
}

async function maybeAutoClose(poll) {
  if (poll.status === 'active' && poll.closes_at && new Date(poll.closes_at) <= new Date()) {
    await pool.query("UPDATE polls SET status = 'closed' WHERE id = $1", [poll.id]);
    poll.status = 'closed';
  }
}

const FREE_POLL_LIMIT = 2; // nombre de sondages réels gratuits par compte
const FREE_MULTI_OPTION_LIMIT = 4; // nombre de candidats max en gratuit pour une élection multi

router.post('/', requireAuth, async (req, res) => {
  try {
    const { title, question, category, scope, pollType, options, securityLevel, closesAt } = req.body || {};
    if (!title || !title.trim()) {
      return res.status(400).json({ error: 'Le titre est requis.' });
    }
    if (!question || !question.trim()) {
      return res.status(400).json({ error: 'La question est requise.' });
    }
    const type = pollType === 'multi' ? 'multi' : 'binaire';
    const security = securityLevel === 'sensible' ? 'sensible' : 'populaire';

    let cleanOptions = [];
    if (type === 'multi') {
      cleanOptions = Array.isArray(options) ? options.map(o => String(o).trim()).filter(Boolean) : [];
      if (cleanOptions.length < 2) {
        return res.status(400).json({ error: 'Une élection multi-candidats nécessite au moins 2 candidats.' });
      }
    }

    const userRes = await pool.query('SELECT plan FROM users WHERE id = $1', [req.user.sub]);
    const plan = userRes.rows[0]?.plan || 'free';
    if (plan === 'free') {
      const { rows: countRows } = await pool.query(
        'SELECT COUNT(*)::int AS n FROM polls WHERE user_id = $1',
        [req.user.sub]
      );
      if (countRows[0].n >= FREE_POLL_LIMIT) {
        return res.status(402).json({
          error: `Limite de ${FREE_POLL_LIMIT} sondages gratuits atteinte. Passe à un abonnement CREATOR ou supérieur pour continuer à créer des sondages.`,
          code: 'FREE_LIMIT_REACHED'
        });
      }
      if (type === 'multi' && cleanOptions.length > FREE_MULTI_OPTION_LIMIT) {
        return res.status(402).json({
          error: `Le plan gratuit limite les élections à ${FREE_MULTI_OPTION_LIMIT} candidats. Passe à un abonnement supérieur pour en ajouter davantage.`,
          code: 'FREE_LIMIT_REACHED'
        });
      }
    }

    let closesAtValue = null;
    if (closesAt) {
      const d = new Date(closesAt);
      if (isNaN(d.getTime()) || d <= new Date()) {
        return res.status(400).json({ error: 'La date de fin doit être une date valide dans le futur.' });
      }
      closesAtValue = d.toISOString();
    }

    let code, inserted;
    for (let attempt = 0; attempt < 5 && !inserted; attempt++) {
      code = generateCode();
      try {
        const { rows } = await pool.query(
          `INSERT INTO polls (code, user_id, title, question, category, scope, poll_type, security_level, closes_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           RETURNING id`,
          [code, req.user.sub, title.trim(), question.trim(), category || 'Société', scope || 'nationale', type, security, closesAtValue]
        );
        inserted = rows[0];
      } catch (err) {
        if (err.code !== '23505') throw err;
      }
    }
    if (!inserted) {
      return res.status(500).json({ error: 'Impossible de générer un code unique, réessaie.' });
    }

    if (type === 'multi') {
      for (let i = 0; i < cleanOptions.length; i++) {
        await pool.query(
          'INSERT INTO poll_options (poll_id, label, display_order) VALUES ($1, $2, $3)',
          [inserted.id, cleanOptions[i], i]
        );
      }
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
      `SELECT id FROM polls WHERE status = 'active' ORDER BY created_at DESC LIMIT 50`
    );
    const polls = await Promise.all(rows.map(r => pollWithResults(r.id)));
    res.json({ polls: polls.filter(Boolean) });
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
    const { choice, optionId } = req.body || {};

    const pollCheck = await pool.query(
      'SELECT id, status, poll_type, security_level, closes_at FROM polls WHERE id = $1',
      [req.params.id]
    );
    const poll = pollCheck.rows[0];
    if (!poll) return res.status(404).json({ error: 'Sondage introuvable.' });

    if (poll.status === 'active' && poll.closes_at && new Date(poll.closes_at) <= new Date()) {
      await pool.query("UPDATE polls SET status = 'closed' WHERE id = $1", [poll.id]);
      poll.status = 'closed';
    }
    if (poll.status !== 'active') {
      return res.status(409).json({ error: 'Ce sondage est fermé, les votes ne sont plus acceptés.' });
    }

    if (poll.security_level === 'sensible') {
      const { rows: uRows } = await pool.query('SELECT voxid_verified FROM users WHERE id = $1', [req.user.sub]);
      if (!uRows[0]?.voxid_verified) {
        return res.status(403).json({
          error: 'Cette élection est sensible et nécessite une identité VoxID vérifiée pour voter.',
          code: 'VOXID_REQUIRED'
        });
      }
    }

    let insertQuery, insertParams;
    if (poll.poll_type === 'multi') {
      if (!optionId) return res.status(400).json({ error: 'Un candidat doit être sélectionné.' });
      const optCheck = await pool.query('SELECT id FROM poll_options WHERE id = $1 AND poll_id = $2', [optionId, poll.id]);
      if (!optCheck.rows[0]) return res.status(400).json({ error: 'Candidat invalide pour ce sondage.' });
      insertQuery = 'INSERT INTO votes (poll_id, user_id, option_id) VALUES ($1, $2, $3)';
      insertParams = [poll.id, req.user.sub, optionId];
    } else {
      if (!['pour', 'contre'].includes(choice)) {
        return res.status(400).json({ error: 'Le choix doit être "pour" ou "contre".' });
      }
      insertQuery = 'INSERT INTO votes (poll_id, user_id, choice) VALUES ($1, $2, $3)';
      insertParams = [poll.id, req.user.sub, choice];
    }

    try {
      await pool.query(insertQuery, insertParams);
    } catch (err) {
      if (err.code === '23505') {
        return res.status(409).json({ error: 'Tu as déjà voté sur ce sondage.' });
      }
      throw err;
    }

    const result = await pollWithResults(poll.id);
    res.status(201).json({ poll: result });
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

router.post('/:id/runoff', requireAuth, async (req, res) => {
  try {
    const { optionIds, closesAt } = req.body || {};
    const original = await pollWithResults(req.params.id);
    if (!original) return res.status(404).json({ error: 'Sondage introuvable.' });
    if (original.user_id !== req.user.sub) {
      return res.status(403).json({ error: "Tu n'es pas l'auteur de ce sondage." });
    }
    if (original.poll_type !== 'multi') {
      return res.status(400).json({ error: 'Le second tour est réservé aux élections à plusieurs candidats.' });
    }
    if (original.status !== 'closed') {
      return res.status(409).json({ error: "L'élection doit être fermée avant de lancer un second tour." });
    }

    const chosenIds = Array.isArray(optionIds) && optionIds.length >= 2
      ? optionIds
      : (original.tie ? original.tie.map(o => o.id) : original.options.slice(0, 2).map(o => o.id));

    const chosenOptions = original.options.filter(o => chosenIds.includes(o.id));
    if (chosenOptions.length < 2) {
      return res.status(400).json({ error: 'Il faut au moins 2 candidats pour un second tour.' });
    }

    let closesAtValue = null;
    if (closesAt) {
      const d = new Date(closesAt);
      if (isNaN(d.getTime()) || d <= new Date()) {
        return res.status(400).json({ error: 'La date de fin doit être une date valide dans le futur.' });
      }
      closesAtValue = d.toISOString();
    }

    let code, inserted;
    for (let attempt = 0; attempt < 5 && !inserted; attempt++) {
      code = generateCode();
      try {
        const { rows } = await pool.query(
          `INSERT INTO polls (code, user_id, title, question, category, scope, poll_type, security_level, closes_at, runoff_of)
           VALUES ($1, $2, $3, $4, $5, $6, 'multi', $7, $8, $9)
           RETURNING id`,
          [code, req.user.sub, original.title + ' — Second tour', original.question,
           original.category, original.scope, original.security_level, closesAtValue, original.id]
        );
        inserted = rows[0];
      } catch (err) {
        if (err.code !== '23505') throw err;
      }
    }
    if (!inserted) return res.status(500).json({ error: 'Impossible de générer un code unique, réessaie.' });

    for (let i = 0; i < chosenOptions.length; i++) {
      await pool.query(
        'INSERT INTO poll_options (poll_id, label, photo_url, display_order) VALUES ($1, $2, $3, $4)',
        [inserted.id, chosenOptions[i].label, chosenOptions[i].photo_url, i]
      );
    }

    const poll = await pollWithResults(inserted.id);
    res.status(201).json({ poll });
  } catch (err) {
    console.error('Erreur POST /polls/:id/runoff :', err);
    res.status(500).json({ error: 'Erreur serveur, réessaie plus tard.' });
  }
});

router.post('/:id/validators', requireAuth, async (req, res) => {
  try {
    const { phone, email } = req.body || {};
    if (!phone && !email) {
      return res.status(400).json({ error: 'Indique le téléphone ou l\'email de la personne de confiance.' });
    }
    const pollRes = await pool.query('SELECT id, user_id FROM polls WHERE id::text = $1 OR code = $1', [req.params.id]);
    const poll = pollRes.rows[0];
    if (!poll) return res.status(404).json({ error: 'Sondage introuvable.' });
    if (poll.user_id !== req.user.sub) {
      return res.status(403).json({ error: "Tu n'es pas l'organisateur de ce sondage." });
    }

    const userRes = await pool.query(
      'SELECT id, name FROM users WHERE phone = $1 OR email = $2',
      [phone || null, email || null]
    );
    const validatorUser = userRes.rows[0];
    if (!validatorUser) {
      return res.status(404).json({ error: 'Aucun compte VoxLive trouvé avec ces coordonnées. La personne doit d\'abord s\'inscrire.' });
    }
    if (validatorUser.id === req.user.sub) {
      return res.status(400).json({ error: 'Tu ne peux pas te désigner toi-même comme validateur.' });
    }

    try {
      await pool.query(
        'INSERT INTO poll_validators (poll_id, validator_user_id, added_by) VALUES ($1, $2, $3)',
        [poll.id, validatorUser.id, req.user.sub]
      );
    } catch (err) {
      if (err.code === '23505') {
        return res.status(409).json({ error: 'Cette personne est déjà validateur pour ce sondage.' });
      }
      throw err;
    }

    res.status(201).json({ validator: { id: validatorUser.id, name: validatorUser.name } });
  } catch (err) {
    console.error('Erreur POST /polls/:id/validators :', err);
    res.status(500).json({ error: 'Erreur serveur, réessaie plus tard.' });
  }
});

router.get('/:id/validators', requireAuth, async (req, res) => {
  try {
    const pollRes = await pool.query('SELECT id, user_id FROM polls WHERE id::text = $1 OR code = $1', [req.params.id]);
    const poll = pollRes.rows[0];
    if (!poll) return res.status(404).json({ error: 'Sondage introuvable.' });
    if (poll.user_id !== req.user.sub) {
      return res.status(403).json({ error: "Tu n'es pas l'organisateur de ce sondage." });
    }
    const { rows } = await pool.query(
      `SELECT u.id, u.name, pv.created_at
       FROM poll_validators pv JOIN users u ON u.id = pv.validator_user_id
       WHERE pv.poll_id = $1 ORDER BY pv.created_at ASC`,
      [poll.id]
    );
    res.json({ validators: rows });
  } catch (err) {
    console.error('Erreur GET /polls/:id/validators :', err);
    res.status(500).json({ error: 'Erreur serveur, réessaie plus tard.' });
  }
});

router.delete('/:id/validators/:validatorId', requireAuth, async (req, res) => {
  try {
    const pollRes = await pool.query('SELECT id, user_id FROM polls WHERE id::text = $1 OR code = $1', [req.params.id]);
    const poll = pollRes.rows[0];
    if (!poll) return res.status(404).json({ error: 'Sondage introuvable.' });
    if (poll.user_id !== req.user.sub) {
      return res.status(403).json({ error: "Tu n'es pas l'organisateur de ce sondage." });
    }
    await pool.query('DELETE FROM poll_validators WHERE poll_id = $1 AND validator_user_id = $2', [poll.id, req.params.validatorId]);
    res.json({ ok: true });
  } catch (err) {
    console.error('Erreur DELETE /polls/:id/validators/:validatorId :', err);
    res.status(500).json({ error: 'Erreur serveur, réessaie plus tard.' });
  }
});

module.exports = router;
