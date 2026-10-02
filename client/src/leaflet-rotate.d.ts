import 'leaflet'

declare module 'leaflet' {
  interface MapOptions {
    rotate?: boolean
    bearing?: number
    rotateControl?: boolean | Record<string, unknown>
    touchRotate?: boolean
    shiftKeyRotate?: boolean
  }

  interface Map {
    setBearing(degrees: number): this
    getBearing(): number
  }
}
