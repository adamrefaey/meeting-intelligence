CREATE TABLE meetings (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  status TEXT NOT NULL CHECK (status IN ('processing', 'ready')),
  embedding_model TEXT,
  embedding_dimensions INTEGER,
  char_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE turns (
  id INTEGER PRIMARY KEY,
  meeting_id INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  turn_index INTEGER NOT NULL,
  speaker TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  start_seconds INTEGER NOT NULL,
  text TEXT NOT NULL
);

CREATE TABLE chunks (
  id INTEGER PRIMARY KEY,
  meeting_id INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  text TEXT NOT NULL,
  speaker_label TEXT NOT NULL,
  start_timestamp TEXT NOT NULL,
  end_timestamp TEXT NOT NULL,
  start_seconds INTEGER NOT NULL,
  end_seconds INTEGER NOT NULL,
  turn_start_index INTEGER NOT NULL,
  turn_end_index INTEGER NOT NULL
);

CREATE TABLE chunk_embeddings (
  chunk_id INTEGER PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
  meeting_id INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  embedding BLOB NOT NULL
);

CREATE VIRTUAL TABLE chunks_fts USING fts5(
  text,
  content='chunks',
  content_rowid='id',
  tokenize='porter unicode61'
);

CREATE TABLE decisions (
  id INTEGER PRIMARY KEY,
  meeting_id INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  speaker TEXT,
  timestamp TEXT
);

CREATE TABLE action_items (
  id INTEGER PRIMARY KEY,
  meeting_id INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  owner TEXT,
  due TEXT,
  timestamp TEXT
);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY,
  meeting_id INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
END;

CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;

CREATE TRIGGER chunks_au AFTER UPDATE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
END;

CREATE INDEX idx_turns_meeting_turn ON turns(meeting_id, turn_index);
CREATE INDEX idx_chunks_meeting_chunk ON chunks(meeting_id, chunk_index);
CREATE INDEX idx_chunk_embeddings_meeting ON chunk_embeddings(meeting_id);
CREATE INDEX idx_messages_meeting_created ON messages(meeting_id, created_at);
