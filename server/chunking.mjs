const DEFAULT_CHUNK_SIZE = 1200;
const DEFAULT_OVERLAP = 180;

export function keywordTokens(value) {
  const text = String(value || "").toLowerCase();
  const latin = text.match(/[a-z0-9][a-z0-9_-]{1,}/g) || [];
  const chineseRuns = text.match(/[\u3400-\u9fff]+/g) || [];
  const chinese = [];

  for (const run of chineseRuns) {
    if (run.length === 1) chinese.push(run);
    for (let index = 0; index < run.length - 1; index += 1) {
      chinese.push(run.slice(index, index + 2));
    }
  }

  return [...new Set([...latin, ...chinese])].slice(0, 240);
}

function splitText(text, chunkSize, overlap) {
  const normalized = String(text || "").replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!normalized) return [];

  const chunks = [];
  let start = 0;
  while (start < normalized.length) {
    let end = Math.min(start + chunkSize, normalized.length);
    if (end < normalized.length) {
      const boundary = Math.max(
        normalized.lastIndexOf("\n", end),
        normalized.lastIndexOf("。", end),
        normalized.lastIndexOf("！", end),
        normalized.lastIndexOf("？", end),
        normalized.lastIndexOf(". ", end)
      );
      if (boundary > start + Math.floor(chunkSize * 0.55)) end = boundary + 1;
    }

    chunks.push(normalized.slice(start, end).trim());
    if (end >= normalized.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks.filter(Boolean);
}

export function chunkSources(sources, options = {}) {
  const chunkSize = Number(options.chunkSize || process.env.CHUNK_SIZE || DEFAULT_CHUNK_SIZE);
  const overlap = Math.min(
    Number(options.overlap || process.env.CHUNK_OVERLAP || DEFAULT_OVERLAP),
    Math.floor(chunkSize / 3)
  );
  const chunks = [];

  for (const source of sources) {
    let chunkIndex = 0;
    for (const page of source.pages || []) {
      for (const content of splitText(page.text, chunkSize, overlap)) {
        chunks.push({
          documentKey: source.documentKey,
          filename: source.filename,
          page: page.page || 1,
          chunkIndex,
          content,
          searchTokens: keywordTokens(content).join(" ")
        });
        chunkIndex += 1;
      }
    }
  }

  return chunks;
}

