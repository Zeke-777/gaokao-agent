const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const STAGING_ROOT = process.env.STAGING_ROOT || path.join(ROOT, 'staging');
const QDRANT = process.env.QDRANT_URL || 'http://127.0.0.1:6333';
const LM = process.env.EMBEDDING_URL || 'http://127.0.0.1:1234/v1/embeddings';
const MODEL = process.env.EMBEDDING_MODEL || 'text-embedding-qwen3-embedding-4b';
const EMBEDDING_KEY = process.env.EMBEDDING_API_KEY || '';
const BATCH_SIZE = Number(process.env.BATCH_SIZE) || 10;

const collectionMap = {
  policies_rules: 'gaokao_policies_rules',
  province_data: 'gaokao_province_data',
  schools: 'gaokao_schools',
  majors: 'gaokao_majors',
  style_cases: 'gaokao_style_cases'
};

function walkMd(dir) {
  const result = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...walkMd(full));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) result.push(full);
  }
  return result;
}

function normalize(text) {
  return text.replace(/\r/g, '').trim();
}

function splitIntoSections(text) {
  const parts = normalize(text).split(/\n(?=# )|\n(?=## )|\n(?=### )/g).map((x) => x.trim()).filter(Boolean);
  return parts.length ? parts : [normalize(text)];
}

function splitLong(section, maxLen = 1200) {
  if (section.length <= maxLen) return [section];
  const paras = section.split(/\n\s*\n/g).map((x) => x.trim()).filter(Boolean);
  const chunks = [];
  let current = '';
  for (const para of paras) {
    if ((current + '\n\n' + para).length > maxLen && current) {
      chunks.push(current.trim());
      current = para;
    } else {
      current = current ? `${current}\n\n${para}` : para;
    }
  }
  if (current) chunks.push(current.trim());
  return chunks;
}

function toChunks(text) {
  return splitIntoSections(text).flatMap((section) => splitLong(section)).filter((x) => x.length > 40);
}

async function embedBatch(inputs) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const headers = { 'Content-Type': 'application/json' };
    if (EMBEDDING_KEY) headers['Authorization'] = `Bearer ${EMBEDDING_KEY}`;
    const res = await fetch(LM, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: MODEL, input: inputs })
    });
    if (res.ok) {
      const data = await res.json();
      return data.data.map((x) => x.embedding);
    }
    const txt = await res.text();
    if (attempt === 4) {
      throw new Error(`embedding_failed ${res.status} ${txt}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
  }
}

async function upsert(collection, points) {
  const res = await fetch(`${QDRANT}/collections/${collection}/points?wait=true`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ points })
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`upsert_failed ${collection} ${res.status} ${txt}`);
  }
  return res.json();
}

async function ingestFolder(key) {
  const folder = path.join(STAGING_ROOT, key);
  const collection = collectionMap[key];
  if (!fs.existsSync(folder) || !collection) return;
  const files = walkMd(folder);
  let totalChunks = 0;
  for (const file of files) {
    const rel = (key + '/' + path.relative(folder, file)).replace(/\\/g, '/');
    const text = fs.readFileSync(file, 'utf8');
    const chunks = toChunks(text);
    totalChunks += chunks.length;
    for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
      const batchTexts = chunks.slice(i, i + BATCH_SIZE);
      const vectors = await embedBatch(batchTexts);
      const points = batchTexts.map((chunk, idx) => {
        const chunkIndex = i + idx;
        const hash = crypto.createHash('sha1').update(`${collection}:${rel}:${chunkIndex}`).digest('hex').slice(0, 32);
        const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
        return {
          id,
          vector: vectors[idx],
          payload: {
            source: rel,
            chunk_index: chunkIndex,
            text: chunk,
            category: key,
            collection
          }
        };
      });
      await upsert(collection, points);
      console.log(`${collection} :: ${rel} :: ${Math.min(i + BATCH_SIZE, chunks.length)}/${chunks.length}`);
    }
  }
  console.log(`DONE ${collection} files=${files.length} chunks=${totalChunks}`);
}

async function main() {
  const keys = process.argv.slice(2);
  const targetKeys = keys.length ? keys : ['majors', 'style_cases', 'policies_rules', 'province_data', 'schools'];
  for (const key of targetKeys) {
    await ingestFolder(key);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
