// Friendly JSON errors for malformed/oversized bodies + final error fallback
function errorMiddleware(err, req, res, next) {
  if (res.headersSent) return next(err);
  if (err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError)) {
    return res.status(400).json({ error: '请求体不是有效的 JSON' });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: '请求体过大（上限 1MB）' });
  }
  res.status(500).json({ error: err && err.message ? err.message : '服务器内部错误' });
}

module.exports = { errorMiddleware };