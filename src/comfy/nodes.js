// Fail fast with a clear error if the workflow templates drift from the node
// ids this server patches, instead of a cryptic TypeError mid-generation.
function requireNodes(wf, label, ids) {
  const missing = ids.filter(id => !wf || !wf[id] || !wf[id].inputs);
  if (missing.length) {
    throw new Error(`${label} workflow 模板与服务端不匹配，缺少节点: ${missing.join(', ')}`);
  }
}


module.exports = { requireNodes };