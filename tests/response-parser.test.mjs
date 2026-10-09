// Run: node --test tests/response-parser.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../Response Monitor.js', import.meta.url), 'utf8');
const a = source.indexOf('  // ---------- 内容有效性深度探测 ----------');
const b = source.indexOf('  // ---------- 运行环境 ----------');
assert.ok(a >= 0 && b > a, 'parser source markers exist');
// Extract browser-independent pure functions; no external dependencies.
const analyze = new Function(source.slice(a, b) + '\nreturn analyzeResponseBody;')();
const event = value => 'data: ' + JSON.stringify(value) + '\n\n';

test('empty streams, whitespace and finish markers are not success', () => {
  assert.equal(analyze('data: [DONE]\n\n').hasContent, false);
  assert.equal(analyze(event({choices:[{delta:{content:''}}]})).hasContent, false);
  assert.equal(analyze(event({choices:[{delta:{content:'   '}}]})).hasContent, false);
});
test('heartbeat, metadata, tools and hidden reasoning are ignored', () => {
  for(const body of [
    ': ping\n\n',
    'event: ping\n\n',
    event({usage:{total_tokens:11},token:'metadata'}),
    event({choices:[{delta:{role:'assistant'}}]}),
    event({choices:[{delta:{reasoning_content:'think'}}]}),
    event({choices:[{delta:{tool_calls:[{id:'call_1'}]}}]}),
    'data: {"',
  ]) assert.equal(analyze(body).hasContent, false, body);
});
test('network chunk boundaries cannot create an early false positive', () => {
  const complete = event({choices:[{delta:{content:'Hello'}}]})+'data: [DONE]\n\n';
  for(let n=1;n<complete.length;n++)
    assert.equal(analyze(complete.slice(0,n)+complete.slice(n)).hasContent, true);
});
test('normal OpenAI, Anthropic, Gemini and Ollama text succeeds', () => {
  for(const body of [
    event({choices:[{delta:{content:'Hi'}}]}),
    event({type:'content_block_delta',delta:{text:'Hi'}}),
    event({candidates:[{content:{parts:[{text:'Hi'}]}}]}),
    '{"response":"Hello","done":true}',
    '{"choices":[{"message":{"content":"Hi"}}]}',
    'legacy plain text',
  ]) assert.equal(analyze(body).hasContent, true, body);
});
test('error in an HTTP 200 response overrides text', () => {
  assert.equal(analyze('{"error":{"message":"fail"}}').isError, true);
  assert.equal(analyze('event: error\ndata: {"error":"fail"}\n\n').isError, true);
  const combined = event({choices:[{delta:{content:'Hi'}}]}) + 'event: error\ndata: {"error":"fail"}\n\n';
  assert.equal(analyze(combined).isError, true);
});
test('truncated JSON and HTML error pages cannot be successful', () => {
  assert.equal(analyze('{"choices":[').hasContent, false);
  assert.equal(analyze('<html>Cloudflare</html>').isError, true);
});
