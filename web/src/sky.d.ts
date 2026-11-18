export type Palette = 'summer' | 'day' | 'pastel';
export type Quality = 'high' | 'balanced' | 'low';

export interface SkyOptions {
  /** 0 = still, 1 = gentle drift, 4 = brisk. Default 1. */
  speed?: number;
  /** 0 = almost clear .. 1 = lots of cloud. Default 0.6. */
  coverage?: number;
  /** Shading inside clouds, 0 .. 1. Default 0.3. */
  shadow?: number;
  /** Cloud size multiplier. Default 1. */
  cloudScale?: number;
  /** Which way the clouds drift. Default 'left'. */
  direction?: 'left' | 'right';
  /** Any number gives a different sky. Default 0. */
  seed?: number;
  /** Sky colours. Default 'summer'. */
  palette?: Palette;
  /** Custom sky colours (hex, e.g. '#2a7be4'); override the palette when set. */
  skyTop?: string | null;
  skyMid?: string | null;
  skyLow?: string | null;
  /** 0 = even blue sky, 1 = deep blue fading to a pale horizon. Default 0. */
  gradient?: number;
  /** Resolution of the cloud snapshots. Default 'high'. */
  quality?: Quality;
  /** Frame cap. Default 60. */
  fps?: number;
  /** Occasional planes with contrails. Default false. */
  planes?: boolean;
  /** Seconds a contrail lingers. Default 40. */
  trailLife?: number;
  /** Hold still when the user prefers reduced motion. Default true. */
  respectReducedMotion?: boolean;
}

export interface ShapeOptions {
  /** Text or emoji to form. */
  text?: string;
  /** Silhouette image: transparent PNG/SVG (alpha is used) or opaque image (dark = shape). URL or element. */
  image?: string | HTMLImageElement | HTMLCanvasElement | ImageBitmap;
  /** One of the built-in symbols (see SKY_SYMBOLS). */
  symbol?: SkySymbolName;
  /** Centre, 0..1 of the view (y = 0 is the bottom). Default 0.5, 0.6. */
  x?: number;
  y?: number;
  /** Height of the shape as a fraction of the view height. Default 0.32. */
  size?: number;
  /** Seconds for a nearby cloud to turn into the shape, to hold it, and to turn back. Default 5, 5, 7.
   * hold: Infinity holds it until releaseShape(). */
  form?: number;
  hold?: number;
  fade?: number;
  /** How dense the finished shape is, 0..1. Default 0.5 (like the clouds around). */
  density?: number;
  /** Wait for the current shape to melt, then form on the same cloud (word, cloud, next word, ...). Default false. */
  queue?: boolean;
  /** Queued only: seconds the cloud shows between the two shapes. 0 = the current shape's outline turns straight
   * into this one once it has held (word, next word, ...; this one's `form` is how long that takes). Default 1. */
  pause?: number;
}

export interface PlaneOptions {
  /** Start and end points, 0..1 of the view (y = 0 is the bottom). Default: random side. */
  from?: [number, number];
  to?: [number, number];
}

export interface Sky {
  readonly canvas: HTMLCanvasElement;
  readonly options: Required<SkyOptions>;
  /** Diagnostics: frames drawn, context losses, the last GL error seen, canvas and snapshot sizes. */
  readonly info: { frames: number; contextLost: boolean; contextLosses: number; glError: number; size: [number, number]; snapshots: [number, number] | null };
  set(options: SkyOptions): void;
  pause(): void;
  play(): void;
  flyPlane(options?: PlaneOptions): void;
  /** A real cloud nearby reshapes into the shape, holds it, then reshapes back into itself. Needs speed > 0. */
  showShape(options: ShapeOptions): Promise<void>;
  /** Remove the shape at once (it vanishes); see releaseShape for the smooth way. */
  clearShape(): void;
  /** Melt the shape on screen back into its cloud now, from wherever it is, and drop the queued ones. */
  releaseShape(): void;
  /** What the shapes are doing: the phase, the text or symbol on screen, and the ones queued after it. */
  readonly shapeState: ShapeState;
  /** PNG data URL of the current frame, or null before the first frame. */
  snapshot(): string | null;
  destroy(): void;
}

export interface ShapeState {
  phase: 'none' | 'waiting' | 'forming' | 'holding' | 'melting';
  label: string | null;
  next: string[];
}
export type SkySymbolName = 'heart' | 'star' | 'sun' | 'moon' | 'smile' | 'music' | 'bolt' | 'infinity';
type SymbolPart = ['fill' | 'line', 'path', string] | ['fill' | 'line', 'circle', number, number, number] | ['fill' | 'line', 'ellipse', number, number, number, number, number];
/** The built-in symbols: a box (x, y, width, height) and parts drawn in it. */
export declare const SKY_SYMBOLS: Record<SkySymbolName, { box: [number, number, number, number]; parts: SymbolPart[] }>;
/** A built-in symbol as SVG markup (default colour: currentColor, for buttons). */
export declare function skySymbolSvg(name: SkySymbolName, color?: string): string;
export declare const SKY_DEFAULTS: Required<SkyOptions>;
/** Drops keys whose value is undefined. */
export declare function cleanOptions(options?: SkyOptions): SkyOptions;
export declare const PALETTES: Record<Palette, { skyTop: string; skyMid: string; skyLow: string }>;
/** One cloud unit in pixels for a w×h view. */
export declare function cloudUnit(w: number, h: number, cloudScale?: number): number;
export declare function createSky(container: HTMLElement, options?: SkyOptions): Sky;
