const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CONFIG = path.join(ROOT, 'config', 'collections.template.json');
const QDRANT = process.env.QDRANT_URL || 'http://127.0.0.1:6333';
const VECTOR_SIZE = Number(process.env.VECTOR_SIZE) || 1024;

async function main() {
  const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  for (const item of cfg.collections) {
    const body = {
      vectors: {
        size: VECTOR_SIZE,
        distance: item.recommendedDistance || 'Cosine'
      }
    };
    const res = await fetch(`${QDRANT}/collections/${item.name}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const json = await res.json();
    console.log(item.name, JSON.stringify(json));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
