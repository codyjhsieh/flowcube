import * as THREE from 'three';
import { Scene } from './render/Scene';
import { CubeView } from './render/CubeView';
import { Controls, CommitMove } from './input/Controls';
import { GameUI, LevelView } from './ui/UI';
import { CubeState, LayerMove } from './game/CubeState';
import { computeFlow, FlowResult } from './game/Flow';
import { buildSolved, LEVELS, levelByIndex } from './game/levels';
import { GameAudio } from './audio/Audio';

interface SaveData {
  gems: number;
  hints: number;
  completed: boolean[];
  bestStars: number[];
  lastLevel: number;
}

const SAVE_KEY = 'flowcube_save_v1';

function loadSave(): SaveData {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (raw) return JSON.parse(raw) as SaveData;
  } catch {
    /* ignore */
  }
  return {
    gems: 120,
    hints: 3,
    completed: new Array(LEVELS.length).fill(false),
    bestStars: new Array(LEVELS.length).fill(0),
    lastLevel: 0,
  };
}

export class App {
  private scene: Scene;
  private view: CubeView;
  private controls: Controls;
  private ui: GameUI;
  private audio = new GameAudio();

  private save: SaveData;
  private index = 0;

  private cube!: CubeState;
  private startCube!: CubeState;
  private colors = new Map<number, number>();
  private flow!: FlowResult;
  private history: LayerMove[] = [];
  private solution: LayerMove[] = []; // always solves from the current state
  private solutionInitial: LayerMove[] = [];

  private won = false;
  private started = false;
  private elapsed = 0;
  private lastTime = 0;
  private hintsLeft = 3;
  private readonly hintsPerLevel = 3;

  constructor() {
    const canvas = document.getElementById('scene') as HTMLCanvasElement;
    const uiRoot = document.getElementById('ui') as HTMLElement;

    this.scene = new Scene(canvas);
    this.view = new CubeView(this.scene.root);
    this.save = loadSave();

    this.ui = new GameUI(uiRoot, {
      onUndo: () => {
        this.audio.tick();
        this.undo();
      },
      onReset: () => {
        this.audio.tick();
        this.reset();
      },
      onHint: () => {
        this.audio.tick();
        this.hint();
      },
      onMenu: () => this.audio.tick(),
      onNextLevel: () => {
        this.audio.tick();
        this.next();
      },
      onSelectLevel: (i) => this.loadLevel(i),
    });

    // Unlock the audio context on the first user gesture (iOS requirement).
    const unlock = () => {
      this.audio.unlock();
      window.removeEventListener('pointerdown', unlock);
    };
    window.addEventListener('pointerdown', unlock);

    this.controls = new Controls(
      canvas,
      this.scene,
      this.view,
      (m) => this.onCommit(m),
      () => this.onFirstMove()
    );

    window.addEventListener('resize', () => this.resize());
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) this.lastTime = performance.now();
    });

    this.resize();
    this.loadLevel(this.save.lastLevel || 0);
    this.lastTime = performance.now();
    requestAnimationFrame(this.loop);

    // Dev sanity check + automated-test hooks.
    if (import.meta.env?.DEV) {
      this.validateLevels();
      (window as unknown as { __fc: unknown }).__fc = {
        solution: () => this.solution.map((m) => ({ ...m })),
        gesture: (m: LayerMove) =>
          this.view.screenGestureFor(
            m,
            this.scene.camera,
            window.innerWidth,
            window.innerHeight
          ),
        won: () => this.won,
        progress: () => ({
          reached: this.flow.reachedSinks.length,
          total: this.flow.totalSinks,
        }),
        level: () => this.index,
        orbit: (az: number, el: number) => this.scene.setOrbit(az, el),
      };
    }
  }

  private persist() {
    this.save.lastLevel = this.index;
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify(this.save));
    } catch {
      /* ignore */
    }
  }

  private levelView(): LevelView {
    const def = levelByIndex(this.index);
    return {
      index: this.index,
      number: def.id,
      name: def.name,
      totalLevels: LEVELS.length,
      hints: this.hintsLeft,
      gems: this.save.gems,
      completedMask: this.save.completed.slice(),
      bestStars: this.save.bestStars.slice(),
    };
  }

  loadLevel(i: number) {
    this.index = Math.max(0, Math.min(LEVELS.length - 1, i));
    const def = levelByIndex(this.index);
    const { cube: solved, colors } = buildSolved(def);
    this.colors = colors;
    const { cube, moves } = solved.scramble(def.seed, def.scramble);
    this.cube = cube;
    this.startCube = cube.clone();
    // The inverse of the scramble solves the start state; we keep this list
    // valid from the current state as the player makes moves.
    this.solutionInitial = moves
      .slice()
      .reverse()
      .map((m) => ({ axis: m.axis, layer: m.layer, turns: -m.turns }));
    this.solution = this.solutionInitial.slice();
    this.history = [];
    this.won = false;
    this.started = false;
    this.elapsed = 0;
    this.hintsLeft = this.hintsPerLevel; // hints reset every level
    this.controls.setLocked(false);

    this.recompute(true);
    this.view.playIntro();
    this.ui.hideWin();
    this.ui.loadLevel(this.levelView());
    this.ui.setProgress(this.flow.reachedSinks.length, this.flow.totalSinks);
    this.persist();
  }

  private recompute(rebuild: boolean) {
    this.flow = computeFlow(this.cube);
    if (rebuild) this.view.build(this.cube, this.flow, this.colors);
  }

  private onFirstMove() {
    if (!this.started) {
      this.started = true;
      this.ui.enterMid();
    }
  }

  private onCommit(m: CommitMove) {
    this.doMove({ axis: m.axis, layer: m.layer, turns: m.turns }, false);
  }

  private trackSolution(m: LayerMove) {
    const head = this.solution[0];
    if (head && head.axis === m.axis && head.layer === m.layer && head.turns === m.turns) {
      this.solution.shift(); // the move was on the solving path
    } else {
      this.solution.unshift({ axis: m.axis, layer: m.layer, turns: -m.turns });
    }
  }

  private doMove(m: LayerMove, fromHint: boolean) {
    if (this.won) return;
    const prevReached = this.flow.reachedSinks.length;
    const prevLeaks = this.flow.leaks;

    this.cube.rotateLayer(m.axis, m.layer, m.turns);
    this.history.push(m);
    this.trackSolution(m);
    this.recompute(true);

    // feedback
    this.audio.snap();
    if (navigator.vibrate) navigator.vibrate(8);
    if (this.flow.reachedSinks.length > prevReached) this.audio.splash(0.7);
    else if (this.flow.leaks > prevLeaks) this.audio.thud();

    this.ui.setProgress(this.flow.reachedSinks.length, this.flow.totalSinks);
    if (this.history.length >= 1) this.ui.dismissHints();
    if (fromHint) this.ui.toast('HINT');
    if (this.flow.solved) this.win();
  }

  private undo() {
    if (this.won || !this.history.length) return;
    const m = this.history.pop()!;
    const inv: LayerMove = { axis: m.axis, layer: m.layer, turns: -m.turns };
    this.cube.rotateLayer(inv.axis, inv.layer, inv.turns);
    this.trackSolution(inv);
    this.recompute(true);
    this.ui.setProgress(this.flow.reachedSinks.length, this.flow.totalSinks);
    if (this.flow.solved) this.win();
  }

  private reset() {
    if (this.won) return;
    this.cube = this.startCube.clone();
    this.history = [];
    this.solution = this.solutionInitial.slice();
    this.recompute(true);
    this.ui.setProgress(this.flow.reachedSinks.length, this.flow.totalSinks);
  }

  private hint() {
    if (this.won) return;
    if (!this.solution.length) {
      this.ui.toast('SOLVED!');
      return;
    }
    this.onFirstMove();
    if (this.hintsLeft > 0) {
      // Each hint advances one move along the canonical solving path.
      this.hintsLeft -= 1;
      this.ui.setHints(this.hintsLeft);
      this.doMove({ ...this.solution[0] }, true);
    } else {
      // Out of hints: finish the solve.
      this.ui.toast('SOLVING');
      while (this.solution.length && !this.won) {
        this.doMove({ ...this.solution[0] }, true);
      }
    }
  }

  private win() {
    this.won = true;
    this.controls.setLocked(true);
    const def = levelByIndex(this.index);
    const moves = this.history.length;
    const stars =
      moves <= Math.ceil(def.scramble * 1.4)
        ? 3
        : moves <= Math.ceil(def.scramble * 2.4)
          ? 2
          : 1;
    const award = stars === 3 ? 10 : stars === 2 ? 6 : 3;

    const firstClear = !this.save.completed[this.index];
    const prevBest = this.save.bestStars[this.index] || 0;
    this.save.completed[this.index] = true;
    this.save.bestStars[this.index] = Math.max(prevBest, stars);
    if (firstClear || stars > prevBest) {
      this.save.gems += award;
    } else {
      this.save.gems += Math.max(1, Math.floor(award / 2));
    }
    this.persist();

    this.audio.win();
    setTimeout(() => this.ui.showWin(stars, award, this.save.gems), 650);
    if ('vibrate' in navigator) navigator.vibrate?.([10, 40, 18]);
  }

  private next() {
    const ni = (this.index + 1) % LEVELS.length;
    this.loadLevel(ni);
  }

  private resize() {
    this.scene.resize(window.innerWidth, window.innerHeight);
    this.view.setResolution(window.innerWidth, window.innerHeight);
  }

  private loop = (now: number) => {
    const dt = Math.min(0.05, (now - this.lastTime) / 1000);
    this.lastTime = now;

    this.controls.update(dt);
    this.scene.tick(now / 1000);
    this.view.update(dt, now / 1000);

    if (this.started && !this.won) {
      this.elapsed += dt;
      this.ui.setTimer(Math.floor(this.elapsed));
    }

    this.scene.render();
    requestAnimationFrame(this.loop);
  };

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private validateLevels() {
    for (const def of LEVELS) {
      const { cube } = buildSolved(def);
      const f = computeFlow(cube);
      if (!f.solved) {
        // eslint-disable-next-line no-console
        console.warn(
          `[flowcube] level ${def.id} "${def.name}" solved state is NOT solved`,
          f.reachedSinks.length,
          '/',
          f.totalSinks
        );
      }
    }
  }
}

