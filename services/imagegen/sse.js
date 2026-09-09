/**
 * SSE Parser ported directly from openai/openai-imagegen-demo (lib/sse.ts)
 */

function parseSseChunk(rawChunk) {
  const lines = rawChunk.split('\n');
  let eventName = 'message';
  const dataLines = [];

  for (const line of lines) {
    if (!line || line.startsWith(':')) continue;
    if (line.startsWith('event:')) {
      eventName = line.slice(6).trim();
      continue;
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  if (!dataLines.length) return null;

  return {
    eventName,
    data: dataLines.join('\n')
  };
}

function formatSseChunk(eventName, payload) {
  return `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
}

module.exports = {
  parseSseChunk,
  formatSseChunk
};
