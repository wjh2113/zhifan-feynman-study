import { createHash } from "node:crypto";
import { keywordTokens } from "./chunking.mjs";

export const embeddingDimensions = Math.max(64, Number(process.env.EMBEDDING_DIMENSIONS || 1024));
const baseUrl = (process.env.EMBEDDING_BASE_URL || "").replace(/\/$/, "");
const apiKey = process.env.EMBEDDING_API_KEY || "";
const model = process.env.EMBEDDING_MODEL || "BAAI/bge-m3";

function normalize(vector) {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / norm);
}

function localEmbedding(text) {
  const vector = new Array(embeddingDimensions).fill(0);
  const normalized = String(text || "").toLowerCase();
  const features = [
    ...keywordTokens(normalized),
    ...Array.from({ length: Math.max(0, normalized.length - 2) }, (_, index) =>
      normalized.slice(index, index + 3)
    )
  ].slice(0, 12000);

  for (const feature of features) {
    const digest = createHash("sha256").update(feature).digest();
    const index = digest.readUInt32BE(0) % embeddingDimensions;
    vector[index] += digest[4] % 2 === 0 ? 1 : -1;
  }
  return normalize(vector);
}

async function remoteEmbeddings(texts) {
  const response = await fetch(`${baseUrl}/embeddings`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ model, input: texts })
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Embedding API ${response.status}: ${detail.slice(0, 240)}`);
  }
  const payload = await response.json();
  const rows = [...(payload.data || [])].sort((a, b) => a.index - b.index);
  if (rows.length !== texts.length) throw new Error("Embedding API 返回数量与输入不一致");
  return rows.map((row) => {
    if (!Array.isArray(row.embedding) || row.embedding.length !== embeddingDimensions) {
      throw new Error(`Embedding 维度必须为 ${embeddingDimensions}`);
    }
    return normalize(row.embedding.map(Number));
  });
}

export async function embedTexts(texts) {
  const values = texts.map((item) => String(item || ""));
  if (!values.length) return [];
  if (!baseUrl || !apiKey) return values.map(localEmbedding);

  const output = [];
  for (let index = 0; index < values.length; index += 24) {
    output.push(...(await remoteEmbeddings(values.slice(index, index + 24))));
  }
  return output;
}

export function embeddingStatus() {
  return {
    provider: baseUrl && apiKey ? "remote" : "local-hash",
    model: baseUrl && apiKey ? model : "offline-feature-hash",
    dimensions: embeddingDimensions
  };
}

