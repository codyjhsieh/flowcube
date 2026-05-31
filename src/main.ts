import './style.css';
import { App } from './app';

// Prevent iOS Safari double-tap zoom / pull-to-refresh on the play surface.
document.addEventListener(
  'gesturestart',
  (e) => e.preventDefault(),
  { passive: false }
);
document.addEventListener(
  'touchmove',
  (e) => {
    if ((e as TouchEvent).touches.length > 1) e.preventDefault();
  },
  { passive: false }
);

window.addEventListener('DOMContentLoaded', () => {
  new App();
});
