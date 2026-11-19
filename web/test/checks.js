// Behaviour checks for the parts the pixel scenes can't see: shapes are built in a worker and placed after an
// asynchronous readback, so the queue, clearing, pausing, morphing and destroying are checked in real time, with
// the worker, with a worker that can't be created, and with one that fails to load (both fall back to the main
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
  const st = () => sky.shapeState, quick = { form: 1, hold: 1, fade: 1 };

  await sky.showShape({ text: 'hello', ...quick });
  check('a word forms', await until(() => st().phase === 'forming' || st().phase === 'holding') && st().label === 'hello', JSON.stringify(st()));

  sky.clearShape();
  await sky.showShape({ text: 'abc' });
  sky.clearShape();
  await wait(300);
  check('clearShape right after the build leaves nothing', st().phase === 'none', JSON.stringify(st()));

  await Promise.all([sky.showShape({ text: 'one', ...quick }), sky.showShape({ text: 'two', ...quick, queue: true })]);
  await until(() => st().label === 'one');
  check('a queued word waits for the first', st().label === 'one' && st().next.join() === 'two', JSON.stringify(st()));
  sky.releaseShape();
  check('releaseShape drops the queue', st().next.length === 0, JSON.stringify(st()));
  check('then it melts away', await until(() => st().phase === 'none'), JSON.stringify(st()));

  sky.showShape({ text: 'old' }); await sky.showShape({ text: 'new' });
  check('a newer word wins', await until(() => st().label === 'new') && (await wait(200), st().label === 'new'), JSON.stringify(st()));
  sky.clearShape();

  sky.pause();
  await sky.showShape({ text: 'paused' });
  check('a shape lands while the sky is paused', await until(() => st().label === 'paused') && st().phase === 'waiting', JSON.stringify(st()));
  sky.play();
  check('and forms after play', await until(() => st().phase === 'forming'), JSON.stringify(st()));
  sky.clearShape();

  await Promise.all([sky.showShape({ text: 'aa', ...quick }), sky.showShape({ text: 'bb', ...quick, queue: true, pause: 0 })]);
  check('pause 0 turns one word into the next', await until(() => st().label === 'bb', 8000), JSON.stringify(st()));
  sky.clearShape();

  const pending = sky.showShape({ symbol: 'heart' });
  check('no GL errors', !sky.info.glError, 'glError ' + sky.info.glError);
  sky.destroy(); box.remove();
  check('showShape returns after destroy', await Promise.race([pending.then(() => true, () => true), wait(3000).then(() => false)]));
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
