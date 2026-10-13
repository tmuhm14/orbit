import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureInput } from './validation.ts';
const valid = { workspaceId: '12345678-1234-1234-1234-123456789abc', title: 'Test capture', text: 'Synthetic note' };
test('capture accepts plain text and rejects invalid fields and oversized input', () => {
  assert.equal(captureInput(valid), true);
  for (const value of [null, [], { ...valid, workspaceId: 'invalid' }, { ...valid, title: ' ' },
    { ...valid, text: 'a'.repeat(50001) }, { ...valid, title: 'a'.repeat(2001) },
    { ...valid, user_id: 'someone-else' }, { ...valid, bucket: 'reference' }])
    assert.equal(captureInput(value), false);
});
