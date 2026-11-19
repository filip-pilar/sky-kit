import type { CSSProperties, ForwardRefExoticComponent, ReactNode, RefAttributes } from 'react';
import type { PlaneOptions, ShapeOptions, ShapeState, SkyOptions } from './sky.js';

export interface SkyHandle {
  flyPlane(options?: PlaneOptions): void;
  showShape(options: ShapeOptions): Promise<void> | undefined;
  clearShape(id?: string): void;
  releaseShape(id?: string): void;
  /** What the shapes are doing (null before mount). */
  readonly shapeState: ShapeState | null;
  /** The same for every id in use (null before mount). */
  readonly shapeStates: Record<string, ShapeState> | null;
  pause(): void;
  play(): void;
  snapshot(): string | null;
  readonly canvas: HTMLCanvasElement | null;
  /** Current options of the sky (null before mount). */
  readonly options: Required<SkyOptions> | null;
}

export interface SkyProps extends SkyOptions {
  className?: string;
  style?: CSSProperties;
  /** Content layered on top of the sky. */
  children?: ReactNode;
}

export declare const Sky: ForwardRefExoticComponent<SkyProps & RefAttributes<SkyHandle>>;
