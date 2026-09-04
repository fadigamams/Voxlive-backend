CREATE TABLE IF NOT EXISTS polls (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code         VARCHAR(20) UNIQUE NOT NULL,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title        VARCHAR(200) NOT NULL,
  question     TEXT NOT NULL,
  category     VARCHAR(50) NOT NULL DEFAULT 'Société',
  scope        VARCHAR(20) NOT NULL DEFAULT 'nationale',
  status       VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS votes (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  poll_id      UUID NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  choice       VARCHAR(10) NOT NULL CHECK (choice IN ('pour','contre')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT one_vote_per_user_per_poll UNIQUE (poll_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_polls_user ON polls (user_id);
CREATE INDEX IF NOT EXISTS idx_polls_status ON polls (status);
CREATE INDEX IF NOT EXISTS idx_votes_poll ON votes (poll_id);
