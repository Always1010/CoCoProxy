import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Script } from 'node:vm';
import test from 'node:test';
import ts from '../tooling/node_modules/typescript/lib/typescript.js';

const source = await readFile(new URL('../integrations/metacubexd/overlay/packages/ui/composables/useGroupRailResize.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;

function fixture(savedWidth = 0) {
  const mouseLayout = { value: true }, containerWidth = { value: 1000 }, saved = { value: savedWidth };
  let changed!: (available: boolean) => void, unmount!: () => void;
  const exports: Record<string, any> = {};
  new Script(code, { filename: 'useGroupRailResize.js' }).runInNewContext({
    exports, ref: (value: unknown) => ({ value }),
    computed: (get: () => unknown) => ({ get value() { return get(); } }),
    useMediaQuery: () => mouseLayout, useElementSize: () => ({ width: containerWidth }),
    useLocalStorage: () => saved,
    watch: (_: unknown, callback: typeof changed) => { changed = callback; },
    onBeforeUnmount: (callback: () => void) => { unmount = callback; },
  });
  let capture: number | null = null;
  const handle = {
    setPointerCapture: (id: number) => { capture = id; },
    hasPointerCapture: (id: number) => capture === id,
    releasePointerCapture: () => { capture = null; },
  };
  const resize = exports.useGroupRailResize({ value: {} }, { value: { getBoundingClientRect: () => ({ width: resize.railStyle.value ? resize.currentWidth.value : 192 }) } });
  const pointer = (clientX: number, pointerType = 'mouse', pointerId = 1) => ({
    clientX, pointerType, pointerId, button: 0, currentTarget: handle, preventDefault() {},
  });
  return { resize, mouseLayout, containerWidth, saved, pointer, capture: () => capture,
    modeChanged: () => changed(resize.canResize.value), unmount: () => unmount() };
}

test('rail width keeps the default until adjusted and ignores desktop preferences in touch and narrow layouts', () => {
  const { resize, saved, mouseLayout, containerWidth, pointer } = fixture();
  assert.equal(resize.railStyle.value, undefined);
  saved.value = 300;
  assert.equal(resize.railStyle.value['--group-rail-width'], '300px');
  mouseLayout.value = false;
  assert.equal(resize.canResize.value, false);
  assert.equal(resize.railStyle.value, undefined);
  resize.startResize(pointer(200));
  assert.equal(resize.dragging.value, false);
  assert.equal(saved.value, 300);
  mouseLayout.value = true;
  containerWidth.value = 500;
  assert.equal(resize.canResize.value, false);
  assert.equal(resize.railStyle.value, undefined);
  containerWidth.value = 620;
  assert.equal(resize.currentWidth.value, 288); // Retain 320px for nodes plus the original 12px gap.
  assert.equal(saved.value, 300);
  containerWidth.value = 1000;
  assert.equal(resize.currentWidth.value, 300);
  saved.value = NaN;
  assert.equal(resize.railStyle.value, undefined);
});

test('mouse dragging respects pane limits and releases capture on cancellation, touch mode and unmount', () => {
  const { resize, saved, mouseLayout, pointer, capture, modeChanged, unmount } = fixture();
  resize.startResize(pointer(200, 'touch'));
  assert.equal(resize.dragging.value, false);
  resize.startResize(pointer(200));
  assert.equal(capture(), 1);
  resize.moveResize(pointer(310, 'mouse', 2));
  assert.equal(saved.value, 0);
  resize.moveResize(pointer(310));
  assert.equal(saved.value, 302);
  resize.moveResize(pointer(1000));
  assert.equal(saved.value, 384);
  resize.moveResize(pointer(-100));
  assert.equal(saved.value, 192);
  resize.endResize(pointer(-100));
  assert.equal(capture(), null);
  assert.equal(resize.dragging.value, false);
  resize.startResize(pointer(200));
  mouseLayout.value = false;
  modeChanged();
  assert.equal(capture(), null);
  mouseLayout.value = true;
  resize.startResize(pointer(200));
  unmount();
  assert.equal(capture(), null);
});

test('keyboard resizing and reset preserve touch mode and restore the original default', () => {
  const { resize, mouseLayout, saved } = fixture(280);
  const key = (key: string) => ({ key, preventDefault() {} });
  resize.resizeWithKeyboard(key('ArrowRight'));
  assert.equal(saved.value, 296);
  resize.resizeWithKeyboard(key('ArrowLeft'));
  assert.equal(saved.value, 280);
  mouseLayout.value = false;
  resize.resizeWithKeyboard(key('ArrowRight'));
  assert.equal(saved.value, 280);
  mouseLayout.value = true;
  resize.resizeWithKeyboard(key('Home'));
  assert.equal(saved.value, 0);
  assert.equal(resize.railStyle.value, undefined);
  assert.equal(resize.hasPreference.value, false);
});
