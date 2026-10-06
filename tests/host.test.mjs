/**
 * Unit tests for the dsh-flow host half.
 *
 * The half owns exactly two facts: the preference surface the settings provider
 * projects into the `flow` namespace, and the presentation policy that stops it
 * from also auto-generating a page for that namespace.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import z from '@deepseek-ai/schemastery'
import { Config, apply, name } from '../index.js'

test('the host row is named after its bundle id', () => {
  assert.equal(name, 'flow')
})

test('the preference defaults to a shown button', () => {
  // A volatile field resolves to a live reference, which is exactly what lets
  // both the Host and a settings write follow the same value.
  assert.equal(z.resolve({}, Config)[0].locateButton.get(), true)
  assert.equal(z.resolve({ locateButton: false }, Config)[0].locateButton.get(), false)
})

test('the copy switch defaults to on, and is volatile for the same reason', () => {
  assert.equal(z.resolve({}, Config)[0].copySessionId.get(), true)
  assert.equal(z.resolve({ copySessionId: false }, Config)[0].copySessionId.get(), false)
  const field = Config.dict.copySessionId
  assert.equal(field.meta.volatile, true)
  assert.equal(field.type, 'boolean')
})

test('the toggles are volatile, which is what the settings form projects', () => {
  for (const name of ['locateButton', 'copySessionId']) {
    const field = Config.dict[name]
    assert.equal(field.meta.volatile, true, name)
    assert.equal(field.type, 'boolean', name)
  }
})

test('apply claims the flow namespace as a hand-written page', () => {
  const configured = []
  const effects = []
  const ctx = {
    fiber: { id: 'flow-fiber' },
    inject: (names, callback) => {
      assert.deepEqual(names, ['settings'])
      callback({
        effect: (callback) => { effects.push(callback); callback(); return () => {} },
        settings: {
          configure: (presentation, owner) => { configured.push({ presentation, owner }); return () => {} },
        },
      })
    },
  }
  apply(ctx)
  assert.deepEqual(configured, [{ presentation: { auto: false }, owner: ctx.fiber }])
  assert.equal(effects.length, 1)
})

test('apply survives a deployment without the settings service', () => {
  let ran = false
  apply({ fiber: {}, inject: (_names, _callback) => { ran = true } })
  assert.equal(ran, true)
})
