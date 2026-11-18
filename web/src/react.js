/**
 * React wrapper for sky-kit. Plain JS (no JSX), so it works without a build step.
 *
 *   import { Sky } from 'sky-kit/react';
 *   const ref = useRef(null);
 *   <Sky ref={ref} coverage={0.6} style={{ height: 400 }}>
 *     <h1>Overlay content</h1>
 *   </Sky>
 *   ref.current.showShape({ text: 'hi' });
 *
 * Any option from SKY_DEFAULTS can be passed as a prop and changed live.
 */
import { createElement, forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { createSky, cleanOptions, SKY_DEFAULTS } from './sky.js';

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

  // Send the full option set each time, so a removed prop goes back to its default.
  const key = JSON.stringify(options);
  useEffect(() => { skyRef.current?.set({ ...SKY_DEFAULTS, ...cleanOptions(optsRef.current) }); }, [key]);

  useImperativeHandle(ref, () => ({
    flyPlane: o => skyRef.current?.flyPlane(o),
    showShape: o => skyRef.current?.showShape(o),
    clearShape: () => skyRef.current?.clearShape(),
    releaseShape: () => skyRef.current?.releaseShape(),
    get shapeState() { return skyRef.current?.shapeState ?? null; },
    pause: () => skyRef.current?.pause(),
    play: () => skyRef.current?.play(),
    snapshot: () => skyRef.current?.snapshot() ?? null,
    get canvas() { return skyRef.current?.canvas ?? null; },
    get options() { return skyRef.current?.options ?? null; },
  }), []);

  return createElement('div', { className, style: { position: 'relative', overflow: 'hidden', ...style } },
    createElement('div', { ref: layerRef, style: FILL }),
    children == null ? null : createElement('div', { style: { position: 'relative', height: '100%' } }, children));
});
