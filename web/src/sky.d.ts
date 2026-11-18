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
  /** Centre, 0..1 of the view (y = 0 is the bottom). Default 0.5, 0.6. */
  x?: number;
  y?: number;
  /** Height of the shape as a fraction of the view height. Default 0.32. */
  size?: number;
  /** Seconds for a nearby cloud to turn into the shape, to hold it, and to turn back. Default 5, 5, 7. */
  form?: number;
  hold?: number;
  fade?: number;
  /** How dense the finished shape is, 0..1. Default 0.5 (like the clouds around). */
  density?: number;
  /** Wait for the current shape to melt, then form on a cloud near it (word, cloud, next word, ...). Default false. */
  queue?: boolean;
}

export interface PlaneOptions {
  /** Start and end points, 0..1 of the view (y = 0 is the bottom). Default: random side. */
  from?: [number, number];
  to?: [number, number];
}

export interface Sky {
  readonly canvas: HTMLCanvasElement;
  readonly options: Required<SkyOptions>;
  set(options: SkyOptions): void;
  pause(): void;
  play(): void;
  flyPlane(options?: PlaneOptions): void;
  /** Nearby clouds drift in and gather into the shape, then it melts back. Needs speed > 0. */
  showShape(options: ShapeOptions): Promise<void>;
  clearShape(): void;
  /** PNG data URL of the current frame, or null before the first frame. */
  snapshot(): string | null;
  destroy(): void;
}

export declare const SKY_DEFAULTS: Required<SkyOptions>;
/** Drops keys whose value is undefined. */
export declare function cleanOptions(options?: SkyOptions): SkyOptions;
export declare const PALETTES: Record<Palette, { skyTop: string; skyMid: string; skyLow: string }>;
/** One cloud unit in pixels for a w×h view. */
export declare function cloudUnit(w: number, h: number, cloudScale?: number): number;
export declare function createSky(container: HTMLElement, options?: SkyOptions): Sky;
