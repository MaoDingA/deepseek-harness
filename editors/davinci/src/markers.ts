/**
 * Runtime vocabulary for timeline markers: the color list accepted by
 * `Timeline:AddMarker` and the type derived from it, so the tool schema and
 * the request type cannot drift apart.
 * @module @deepseek-ai/dsh-davinci/markers
 */

/**
 * Marker colors offered to the model. The tail (Tan/Beige/Brown/Chocolate)
 * comes from the previous plugin and diverges from the 21.1.1 official stubs'
 * MarkerColor (Lemon/Sand/Cocoa/Cream); their runtime acceptance is not yet
 * verified.
 */
export const DAVINCI_MARKER_COLORS = [
  'Blue', 'Cyan', 'Green', 'Yellow', 'Red', 'Pink', 'Purple', 'Fuchsia',
  'Rose', 'Lavender', 'Sky', 'Mint', 'Tan', 'Beige', 'Brown', 'Chocolate',
] as const

/** One marker color from {@link DAVINCI_MARKER_COLORS}. */
export type DavinciMarkerColor = typeof DAVINCI_MARKER_COLORS[number]
