import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import pg from "pg";
import { embeddingDimensions } from "./embedding.mjs";
import { keywordTokens } from "./chunking.mjs";

const { Pool } = pg;
const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const dataDir = path.resolve(process.env.DATA_DIR || path.join(rootDir, ".data"));
export const uploadDir = path.resolve(process.env.UPLOAD_DIR || path.join(dataDir, "uploads"));
const embeddedDbDir = path.resolve(process.env.PGLITE_DATA_DIR || path.join(dataDir, "postgres"));

let databasePromise;

function safeJson(value, fallback = {}) {
  if (value == null) return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }
  return value;
}

function adapterFor(client, mode) {
  return {
    mode,
    query: (text, params = []) => client.query(text, params),
    close: () => client.end?.() || client.close?.()
  };
}

async function createDatabase() {
  await mkdir(dataDir, { recursive: true });
  await mkdir(uploadDir, { recursive: true });

  let db;
  if (process.env.DATABASE_URL) {
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : undefined
    });
    db = adapterFor(pool, "postgresql");
  } else {
    await mkdir(path.dirname(embeddedDbDir), { recursive: true });
    const embedded = process.env.PGLITE_MEMORY === "true"
      ? await PGlite.create({ extensions: { vector } })
      : await PGlite.create(
          `file://${path.relative(process.cwd(), embeddedDbDir).replace(/\\/g, "/")}`,
          { extensions: { vector } }
        );
    db = adapterFor(embedded, "pglite");
  }

  await db.query("CREATE EXTENSION IF NOT EXISTS vector");
  await db.query(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'course',
      state JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      filename TEXT NOT NULL,
      stored_name TEXT NOT NULL,
      storage_path TEXT NOT NULL,
      mime_type TEXT,
      file_type TEXT NOT NULL,
      byte_size BIGINT NOT NULL DEFAULT 0,
      page_count INTEGER NOT NULL DEFAULT 0,
      chunk_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS document_chunks (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      page_number INTEGER NOT NULL DEFAULT 1,
      chunk_index INTEGER NOT NULL,
      content TEXT NOT NULL,
      search_tokens TEXT NOT NULL DEFAULT '',
      embedding vector(${embeddingDimensions}),
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(document_id, chunk_index)
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS learning_events (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.query("CREATE INDEX IF NOT EXISTS idx_documents_project ON documents(project_id)");
  await db.query("CREATE INDEX IF NOT EXISTS idx_chunks_project ON document_chunks(project_id)");
  await db.query("CREATE INDEX IF NOT EXISTS idx_events_project ON learning_events(project_id)");
  return db;
}

export function getDatabase() {
  if (!databasePromise) databasePromise = createDatabase();
  return databasePromise;
}

export async function listProjects() {
  const db = await getDatabase();
  const result = await db.query("SELECT state FROM projects ORDER BY updated_at DESC");
  return result.rows.map((row) => safeJson(row.state));
}

export async function getProject(projectId) {
  const db = await getDatabase();
  const result = await db.query("SELECT state FROM projects WHERE id = $1", [projectId]);
  return result.rows[0] ? safeJson(result.rows[0].state) : null;
}

export async function saveProject(project) {
  if (!project?.id) throw new Error("项目缺少 id");
  const db = await getDatabase();
  await db.query(
    `INSERT INTO projects(id, title, mode, state, created_at, updated_at)
     VALUES ($1, $2, $3, $4::jsonb, TO_TIMESTAMP($5 / 1000.0), NOW())
     ON CONFLICT(id) DO UPDATE SET
       title = EXCLUDED.title,
       mode = EXCLUDED.mode,
       state = EXCLUDED.state,
       updated_at = NOW()`,
    [
      project.id,
      project.title || "新的学习项目",
      project.mode || "course",
      JSON.stringify(project),
      Number(project.createdAt || Date.now())
    ]
  );
  return project;
}

export async function deleteProject(projectId) {
  const db = await getDatabase();
  await db.query("DELETE FROM projects WHERE id = $1", [projectId]);
}

function sanitizeFilename(filename) {
  const cleaned = String(filename || "document")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.slice(0, 160) || "document";
}

export async function persistOriginalFile(projectId, file) {
  const projectFolder = path.join(uploadDir, sanitizeFilename(projectId));
  await mkdir(projectFolder, { recursive: true });
  const extension = path.extname(sanitizeFilename(file.originalname)).toLowerCase().replace(/[^a-z0-9.]/g, "");
  const storedName = `${randomUUID()}${extension}`;
  const storagePath = path.join(projectFolder, storedName);
  await writeFile(storagePath, file.buffer);
  return { storedName, storagePath };
}

function vectorLiteral(vectorValue) {
  return `[${vectorValue.map((value) => Number(value).toFixed(8)).join(",")}]`;
}

export async function saveDocument({ projectId, source, file, chunks, embeddings }) {
  const db = await getDatabase();
  const documentId = source.documentKey || randomUUID();
  const stored = await persistOriginalFile(projectId, file);

  await db.query(
    `INSERT INTO documents(
       id, project_id, filename, stored_name, storage_path, mime_type,
       file_type, byte_size, page_count, chunk_count
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      documentId,
      projectId,
      source.filename,
      stored.storedName,
      stored.storagePath,
      file.mimetype || "application/octet-stream",
      source.type,
      file.size || file.buffer.length,
      source.pages.length,
      chunks.length
    ]
  );

  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    await db.query(
      `INSERT INTO document_chunks(
         id, document_id, project_id, page_number, chunk_index,
         content, search_tokens, embedding, metadata
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::vector,$9::jsonb)`,
      [
        randomUUID(),
        documentId,
        projectId,
        chunk.page,
        chunk.chunkIndex,
        chunk.content,
        chunk.searchTokens,
        vectorLiteral(embeddings[index]),
        JSON.stringify({ filename: source.filename, type: source.type })
      ]
    );
  }

  return {
    id: documentId,
    name: source.filename,
    type: source.type,
    pages: source.pages.length,
    chunks: chunks.length,
    size: Number(file.size || file.buffer.length),
    status: "ready",
    downloadUrl: `/api/documents/${documentId}/file`
  };
}

export async function getDocument(documentId) {
  const db = await getDatabase();
  const result = await db.query("SELECT * FROM documents WHERE id = $1", [documentId]);
  return result.rows[0] || null;
}

export async function recordEvent(projectId, eventType, payload) {
  const db = await getDatabase();
  await db.query(
    "INSERT INTO learning_events(id, project_id, event_type, payload) VALUES ($1,$2,$3,$4::jsonb)",
    [randomUUID(), projectId, eventType, JSON.stringify(payload || {})]
  );
}

export async function hybridSearch(projectId, query, queryEmbedding, limit = 6) {
  const db = await getDatabase();
  const take = Math.max(1, Math.min(Number(limit) || 6, 12));
  const candidates = new Map();
  const vectorResult = await db.query(
    `SELECT id, document_id, page_number, content, metadata,
            1 - (embedding <=> $2::vector) AS vector_score
       FROM document_chunks
      WHERE project_id = $1 AND embedding IS NOT NULL
      ORDER BY embedding <=> $2::vector
      LIMIT $3`,
    [projectId, vectorLiteral(queryEmbedding), take * 3]
  );

  for (const [rank, row] of vectorResult.rows.entries()) {
    candidates.set(row.id, {
      ...row,
      metadata: safeJson(row.metadata),
      vectorScore: Number(row.vector_score || 0),
      keywordScore: 0,
      rrf: 1 / (60 + rank + 1)
    });
  }

  const tokens = keywordTokens(query).slice(0, 24);
  if (tokens.length) {
    const tsQuery = tokens.map((token) => token.replace(/[':&|!()]/g, "")).filter(Boolean).join(" | ");
    const keywordResult = await db.query(
      `SELECT id, document_id, page_number, content, metadata,
              ts_rank_cd(to_tsvector('simple', search_tokens), to_tsquery('simple', $2)) AS keyword_score
         FROM document_chunks
        WHERE project_id = $1
          AND to_tsvector('simple', search_tokens) @@ to_tsquery('simple', $2)
        ORDER BY keyword_score DESC
        LIMIT $3`,
      [projectId, tsQuery, take * 3]
    );
    for (const [rank, row] of keywordResult.rows.entries()) {
      const existing = candidates.get(row.id) || {
        ...row,
        metadata: safeJson(row.metadata),
        vectorScore: 0,
        keywordScore: 0,
        rrf: 0
      };
      existing.keywordScore = Number(row.keyword_score || 0);
      existing.rrf += 1 / (60 + rank + 1);
      candidates.set(row.id, existing);
    }
  }

  return [...candidates.values()]
    .sort((a, b) => b.rrf - a.rrf || b.vectorScore - a.vectorScore)
    .slice(0, take)
    .map((item) => ({
      id: item.id,
      documentId: item.document_id,
      filename: item.metadata?.filename || "学习资料",
      page: Number(item.page_number || 1),
      content: item.content,
      score: Number((item.rrf + Math.max(0, item.vectorScore) * 0.01).toFixed(6))
    }));
}

export async function databaseStatus() {
  const db = await getDatabase();
  const result = await db.query(
    "SELECT COUNT(*)::int AS projects, (SELECT COUNT(*)::int FROM documents) AS documents, (SELECT COUNT(*)::int FROM document_chunks) AS chunks FROM projects"
  );
  return { mode: db.mode, ...(result.rows[0] || { projects: 0, documents: 0, chunks: 0 }) };
}
