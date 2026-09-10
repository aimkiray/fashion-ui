const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

// 预检错误形态分类：PYTHON_BIN 指向不存在的解释器时必须报"解释器不存在"，
// 且 runPythonScript 以 reject 收场、进程不崩（本文件独立进程运行，env 隔离）。

process.env.PYTHON_BIN = path.join(os.tmpdir(), 'no_such_python_dir', 'python');
process.env.PYTHON_BIN_PREFLIGHT = '1';

const { ensurePilPreflight, runPythonScript } = require('../../src/images/pythonBin');

test('preflight classifies a missing interpreter as ENOENT, not missing-Pillow', async () => {
  const pre = await ensurePilPreflight();
  assert.equal(pre.ok, false);
  assert.match(pre.reason, /ENOENT|解释器不存在/);
  assert.doesNotMatch(pre.reason, /^缺少 Pillow/);
});

test('runPythonScript rejects when the interpreter is missing (no unhandled crash)', async () => {
  await assert.rejects(
    runPythonScript('/dev/null/nothing.py', []),
    (err) => !!err
  );
});
