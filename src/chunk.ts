/**
 * Text chunking shared by the CLI ingest script and the `/graph ingest`
 * command.
 *
 * Strategy: chunk by SEMANTIC unit, not by length.
 *   - Each paragraph (blank-line separated block) becomes its own episode.
 *   - Paragraphs are never merged together, so episode boundaries follow the
 *     document's own structure.
 *   - `maxChars` is only a safety cap: a paragraph larger than it is split into
 *     sentences, which are then packed up to `maxChars`. A single sentence that
 *     still exceeds `maxChars` is hard-cut as a last resort.
 *   - `maxChars <= 0` disables the cap entirely and returns the whole text as a
 *     single chunk.
 */
export function chunkText(text: string, maxChars: number): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (maxChars <= 0) return [trimmed];

  const paras = trimmed
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  for (const para of paras) {
    if (para.length <= maxChars) {
      chunks.push(para);
    } else {
      // Oversized paragraph: fall back to sentence packing, then hard cut.
      for (const piece of packSentences(para, maxChars)) chunks.push(piece);
    }
  }
  return chunks;
}

/**
 * Split an oversized paragraph into sentences and pack consecutive sentences
 * together up to `maxChars`. A single sentence longer than `maxChars` is
 * hard-cut into fixed-size slices.
 */
function packSentences(para: string, maxChars: number): string[] {
  const out: string[] = [];
  let cur = "";
  const flush = () => {
    const c = cur.trim();
    if (c) out.push(c);
    cur = "";
  };

  for (const sentence of splitSentences(para)) {
    if (sentence.length > maxChars) {
      flush();
      for (let i = 0; i < sentence.length; i += maxChars) {
        out.push(sentence.slice(i, i + maxChars));
      }
      continue;
    }
    if (cur && cur.length + 1 + sentence.length > maxChars) flush();
    cur = cur ? `${cur} ${sentence}` : sentence;
  }
  flush();
  return out;
}

/**
 * Split text into sentences on sentence-final punctuation (. ! ?) followed by
 * whitespace. Internal newlines count as whitespace, so newline-separated
 * sentences split too. Text with no sentence terminators returns as a single
 * element (the caller hard-cuts if it is still too large).
 */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}
