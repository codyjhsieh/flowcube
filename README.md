# Flow Cube

A minimalist 3D water-routing puzzle for mobile browsers. Rotate the layers of a
grass-and-dirt terrain cube (Rubik-style) to carve a connected path of canals
from the source fountain to every coloured outlet — without springing any leaks.

Built with **TypeScript + Vite + Three.js**. Deterministic grid-based flow
simulation, GPU-cheap sloshing-water shader, hand-drawn edges, and a React-free
render loop.

## Play

Live build (GitHub Pages): deployed automatically from `main`.

## Develop

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # typecheck + production build to dist/
```

Requires Node 18+.

## How it plays

- **Swipe** a face to rotate that layer; release snaps to a quarter turn.
- **Drag the background / two fingers** to orbit the cube.
- Connect the **source** (top fountain) to every **coloured outlet**.
- Decoy canals cover the cube — misroute water and it leaks. A clean solve has
  **zero leaks**.
- **Hint** (lightbulb) advances one move along a guaranteed solution; once hints
  run out it finishes the solve.

## Structure

- `src/game` — cube state, layer rotation, deterministic flow solver, levels
- `src/render` — Three.js scene, terrain/canal/water rendering
- `src/input` — swipe → slice-rotation gesture resolver
- `src/ui` — HUD and screens
