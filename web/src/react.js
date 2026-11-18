/**
 * React wrapper for sky-kit. Plain JS (no JSX), so it works without a build step.
 *
 *   import { Sky } from 'sky-kit/react';
 *   const ref = useRef(null);
 *   <Sky ref={ref} coverage={0.6} interactive style={{ height: 400 }}>
 *     <h1>Overlay content</h1>
 *   </Sky>
 *   ref.current.showShape({ text: 'hi' });
 *
 * Any option from SKY_DEFAULTS can be passed as a prop and changed live.
 */
import { createElement, forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { createSky } from './sky.js';

const FILL = { position: 'absolute', inset: 0 };

export const Sky = forwardRef(function Sky({ className, style, children, ...options }, ref) {
  const layerRef = useRef(null);   // empty box React never touches; the sky canvas lives inside
  const skyRef = useRef(null);
  const optsRef = useRef(options);
  optsRef.current = options;

  useEffect(() => {
    skyRef.current = createSky(layerRef.current, optsRef.current);
    return () => { skyRef.current.destroy(); skyRef.current = null; };
  }, []);

  const key = JSON.stringify(options);
  useEffect(() => { skyRef.current?.set(optsRef.current); }, [key]);

  useImperativeHandle(ref, () => ({
    flyPlane: o => skyRef.current?.flyPlane(o),
    showShape: o => skyRef.current?.showShape(o),
    clearShape: () => skyRef.current?.clearShape(),
    pause: () => skyRef.current?.pause(),
    play: () => skyRef.current?.play(),
    snapshot: () => skyRef.current?.snapshot() ?? null,
    get canvas() { return skyRef.current?.canvas ?? null; },
  }), []);

  return createElement('div', { className, style: { position: 'relative', overflow: 'hidden', ...style } },
    createElement('div', { ref: layerRef, style: FILL }),
    children == null ? null : createElement('div', { style: { position: 'relative', height: '100%' } }, children));
});
