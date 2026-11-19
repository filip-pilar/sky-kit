// Behaviour checks for what the pixel scenes can't see: shapes are built in a worker and placed after an
// asynchronous readback, so the queue, newer calls, clearing mid-placement and several ids are checked in real time,
// with the worker, with a worker that can't be created, and with one that fails to load (both fall back to the main
// thread). Run by scripts/regress.ts through regress.html; returns "PASS …" / "FAIL …" lines.
const wait = ms => new Promise(r => setTimeout(r, ms));
const until = async (f, ms = 5000) => { for (const t = performance.now(); !f(); await wait(10)) if (performance.now() - t > ms) return false; return true; };

class ThrowingWorker { constructor() { throw new DOMException('blocked', 'SecurityError'); } }
class FailingWorker { constructor() { setTimeout(() => this.onerror?.(new Event('error')), 5); } postMessage() {} terminate() {} }

async function checkMode(createSky, mode, out) {
  const check = (name, ok, extra = '') => out.push(`${ok ? 'PASS' : 'FAIL'} [${mode}] ${name}${ok ? '' : ' ' + extra}`);
  const box = document.createElement('div'); box.style.cssText = 'position:relative;width:400px;height:250px';
  document.body.append(box);
  const sky = createSky(box, { speed: 4 });   // (shape times are sky seconds: 4× faster)
  await wait(300);
  const st = () => sky.shapeState, sts = () => sky.shapeStates, quick = { form: 1, hold: 1, fade: 1 };

  await sky.showShape({ text: 'hello', ...quick });
  check('a word forms', await until(() => st().phase === 'forming' || st().phase === 'holding') && st().label === 'hello', JSON.stringify(st()));

  sky.clearShape();
  await sky.showShape({ text: 'abc' });   // (its cloud is still being read back)
  sky.clearShape();
  await wait(300);
  check('clearShape while a shape is being placed leaves nothing', st().phase === 'none', JSON.stringify(st()));

  await Promise.all([sky.showShape({ text: 'one', ...quick }), sky.showShape({ text: 'two', ...quick, queue: true })]);
  await until(() => st().label === 'one');
  check('a queued word waits for the first', st().label === 'one' && st().next.join() === 'two', JSON.stringify(st()));
  sky.releaseShape();
  check('releaseShape drops the queue and melts', st().next.length === 0 && await until(() => st().phase === 'none'), JSON.stringify(st()));

  sky.showShape({ symbol: 'heart' }); await sky.showShape({ text: 'later' });   // (the symbol's picture loads after the call)
  check('a newer call wins, even over a symbol still loading', await until(() => st().label === 'later') && (await wait(300), st().label === 'later'), JSON.stringify(st()));
  sky.clearShape();

  // several shapes at once, each id in its own lane (small, so three fit side by side)
  const small = { ...quick, hold: 20, size: 0.15 };
  await Promise.all([sky.showShape({ text: 'aa', id: 'a', x: 0.25, ...small }), sky.showShape({ text: 'bb', id: 'b', x: 0.75, ...small })]);
  check('two ids are on screen together', await until(() => sts().a?.label === 'aa' && sts().b?.label === 'bb'), JSON.stringify(sts()));
  sky.releaseShape('a');
  check('releaseShape(id) melts only that one', await until(() => !sts().a) && sts().b?.label === 'bb', JSON.stringify(sts()));
  await sky.showShape({ text: 'cc', id: 'c', ...small }); await sky.showShape({ text: 'dd', id: 'd', ...small });
  await until(() => sts().c?.label === 'cc' && sts().d?.label === 'dd');
  await sky.showShape({ text: 'ee', id: 'e', ...small });   // (b, c, d on screen; b was used longest ago)
  check('a 4th id takes over the one used longest ago', await until(() => sts().e?.label === 'ee') && Object.keys(sts()).sort().join() === 'c,d,e', JSON.stringify(sts()));
  sky.clearShape();
  // two words too big to fit side by side: the second takes over the first instead of overlapping it
  await sky.showShape({ text: 'pp', id: 'p', ...quick, hold: 20, size: 0.5 });
  await until(() => sts().p?.label === 'pp');
  await sky.showShape({ text: 'qq', id: 'q', ...quick, hold: 20, size: 0.5 });
  const placed = await until(() => sts().q && sts().q.phase !== 'waiting');   // (the room is judged once its cloud is found)
  check('with no room, a new shape takes over the oldest', placed && Object.keys(sts()).join() === 'q', JSON.stringify(sts()));

  sky.destroy(); box.remove();
}

export async function runChecks(createSky) {
  const out = [], errors = [], Real = window.Worker;
  const onError = e => errors.push(e.message ?? String(e.reason));
  addEventListener('error', onError); addEventListener('unhandledrejection', onError);
  for (const [mode, W] of [['worker', Real], ['no worker', ThrowingWorker], ['worker fails', FailingWorker]]) {
    window.Worker = W;
    try { await checkMode(createSky, mode, out); } catch (e) { out.push(`FAIL [${mode}] threw ${e}`); }
  }
  window.Worker = Real;
  removeEventListener('error', onError); removeEventListener('unhandledrejection', onError);
  out.push(errors.length ? `FAIL no uncaught errors: ${errors.join(' | ')}` : 'PASS no uncaught errors');
  return out;
}
