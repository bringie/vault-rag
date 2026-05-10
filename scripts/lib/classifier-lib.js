const REQUIRED_FIELDS = ['target_folder', 'tags', 'summary', 'type', 'confidence'];

function parseClaudeResponse(stdout) {
  let outer;
  try {
    outer = JSON.parse(stdout);
  } catch (e) {
    const err = new Error(`parse_error: ${e.message}`);
    err.code = 'parse_error';
    throw err;
  }

  let payload = outer;
  if (typeof outer.result === 'string') {
    try { payload = JSON.parse(outer.result); }
    catch (e) {
      const err = new Error(`parse_error: inner result not JSON: ${e.message}`);
      err.code = 'parse_error';
      throw err;
    }
  }

  for (const k of REQUIRED_FIELDS) {
    if (payload[k] === undefined || payload[k] === null) {
      const err = new Error(`missing_field: ${k}`);
      err.code = 'missing_field';
      throw err;
    }
  }

  let conf = Number(payload.confidence);
  if (!Number.isFinite(conf)) conf = 0;
  if (conf < 0) conf = 0;
  if (conf > 1) conf = 1;

  return {
    target_folder: String(payload.target_folder),
    tags: Array.isArray(payload.tags) ? payload.tags.map(String) : [],
    summary: String(payload.summary).slice(0, 200),
    type: String(payload.type),
    confidence: conf,
  };
}

module.exports = { parseClaudeResponse };
