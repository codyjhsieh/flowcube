/**
 * Flow Cube — DOM HUD overlay.
 *
 * Builds the hand-drawn children's-puzzle HUD on top of the 3D cube canvas.
 * Reuses the class names defined in `src/style.css`. Three visual states are
 * driven by classes on the `#app` element:
 *   (none)      -> play   (green)
 *   state-mid   -> mid    (teal, timer + center hint visible)
 *   state-win   -> win    (gold, celebration overlay)
 */

export interface UICallbacks {
  onUndo: () => void;
  onReset: () => void;
  onHint: () => void;
  onMenu: () => void;
  onNextLevel: () => void;
  onSelectLevel: (index: number) => void;
}

export interface LevelView {
  index: number;
  number: number;
  name: string;
  totalLevels: number;
  hints: number;
  gems: number;
  completedMask: boolean[];
  bestStars: number[];
}

const CONFETTI_COLORS = [
  '#8fbf63',
  '#4a90c2',
  '#e09a4a',
  '#4fae8c',
  '#e6c34a',
  '#ffffff',
] as const;

const CONFETTI_COUNT = 40;

/** Inline SVG markup kept tiny + static; safe to assign via innerHTML. */
const SVG_CLOCK =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">' +
  '<circle cx="12" cy="12" r="9"></circle>' +
  '<path d="M12 7v5l3 2"></path></svg>';

const SVG_UNDO =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M4 8h9a6 6 0 0 1 0 12H8"></path>' +
  '<path d="M4 8l4-4M4 8l4 4"></path></svg>';

const SVG_RESET =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M20 12a8 8 0 1 1-2.34-5.66"></path>' +
  '<path d="M20 4v5h-5"></path></svg>';

function pad2(n: number): string {
  return n < 10 ? '0' + n : String(n);
}

function fmtTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  return pad2(mm) + ':' + pad2(ss);
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export class GameUI {
  private readonly root: HTMLElement;
  private readonly cb: UICallbacks;
  private readonly app: HTMLElement;

  // Persistent references to dynamic nodes.
  private readonly levelTitle: HTMLElement;
  private readonly dots: HTMLElement;
  private readonly timerText: HTMLElement;
  private readonly counter: HTMLElement;
  private readonly counterIco: HTMLElement;
  private readonly counterNum: HTMLElement;
  private readonly centerHint: HTMLElement;
  private readonly objective: HTMLElement;

  // Win overlay nodes.
  private readonly win: HTMLElement;
  private readonly winLvl: HTMLElement;
  private readonly winComplete: HTMLElement;
  private readonly stars: HTMLElement[];
  private readonly perfect: HTMLElement;
  private readonly rewardNum: HTMLElement;

  // Floating / modal nodes.
  private readonly toastNode: HTMLElement;
  private readonly confetti: HTMLElement;
  private readonly sheet: HTMLElement;
  private readonly levelgrid: HTMLElement;

  // Timers we may need to clear.
  private toastTimer = 0;
  private objectiveTimer = 0;
  private readonly starTimers: number[] = [];

  // Latest level snapshot (used to rebuild the menu grid).
  private view: LevelView | null = null;

  constructor(root: HTMLElement, cb: UICallbacks) {
    this.root = root;
    this.cb = cb;
    this.app = (document.getElementById('app') as HTMLElement | null) ?? root;

    this.root.replaceChildren();

    // ----------------------------------------------------------- TOP BAR
    const topbar = el('div', 'topbar');

    const menuBtn = el('button', 'icon-btn menu-btn');
    menuBtn.type = 'button';
    menuBtn.setAttribute('aria-label', 'Menu');
    for (let i = 0; i < 3; i++) menuBtn.appendChild(el('span'));
    menuBtn.addEventListener('click', () => this.openSheet());

    const levelHead = el('div', 'level-head');
    this.levelTitle = el('div', 'level-title', 'LEVEL 1');
    this.dots = el('div', 'dots');
    const timer = el('div', 'timer');
    const timerIcon = el('span');
    timerIcon.innerHTML = SVG_CLOCK;
    this.timerText = el('span', undefined, '00:00');
    timer.append(timerIcon, this.timerText);
    levelHead.append(this.levelTitle, this.dots, timer);

    this.counter = el('button', 'icon-btn counter');
    (this.counter as HTMLButtonElement).type = 'button';
    this.counterIco = el('span', 'ico bulb', '💡');
    this.counterNum = el('span', undefined, '0');
    this.counter.append(this.counterIco, this.counterNum);
    this.counter.addEventListener('click', () => this.onCounterClick());

    topbar.append(menuBtn, levelHead, this.counter);

    // ----------------------------------------------------------- SPACER
    const spacer = el('div', 'spacer');

    // ------------------------------------------------------ CENTER HINT
    this.centerHint = el('div', 'center-hint');
    const line1 = el('div', 'line', 'ROTATE ANY LAYER');
    const line2 = el('div', 'line', 'SWIPE ON THE CUBE');
    const hand = el('div', 'hand', '👆');
    this.centerHint.append(line1, line2, hand);

    // --------------------------------------------------------- OBJECTIVE
    this.objective = el('div', 'objective');
    const objLine = el('div', undefined, 'CONNECT THE SOURCE TO ALL OUTLETS');
    const objRule = el('span', 'rule');
    this.objective.append(objLine, objRule);

    // ---------------------------------------------------- BOTTOM TOOLBAR
    const bottombar = el('div', 'bottombar');
    const undoTool = this.makeTool(SVG_UNDO, 'UNDO', () => this.cb.onUndo());
    const resetTool = this.makeTool(SVG_RESET, 'RESET', () => this.cb.onReset());
    bottombar.append(undoTool, resetTool);

    // -------------------------------------------------------- WIN OVERLAY
    this.win = el('div', 'win');
    this.winLvl = el('div', 'lvl', 'LEVEL 1');
    this.winComplete = el('div', 'complete', 'COMPLETE!');
    const divider = el('div', 'divider', '◇');

    const starsWrap = el('div', 'stars');
    this.stars = [];
    for (let i = 0; i < 3; i++) {
      const star = el('div', i === 1 ? 'star mid' : 'star', '★');
      this.stars.push(star);
      starsWrap.appendChild(star);
    }

    this.perfect = el('div', 'perfect', 'PERFECT FLOW!');

    const reward = el('div', 'reward');
    const rewardGem = el('span', 'gem', '💎');
    this.rewardNum = el('span', undefined, '+0');
    reward.append(rewardGem, this.rewardNum);

    const actions = el('div', 'actions');

    const ghostBtn = el('button', 'btn ghost');
    ghostBtn.type = 'button';
    const grid2 = el('span', 'grid2');
    for (let i = 0; i < 4; i++) grid2.appendChild(el('i'));
    ghostBtn.append(grid2, el('span', undefined, 'LEVELS'));
    ghostBtn.addEventListener('click', () => this.openSheet());

    const primaryBtn = el('button', 'btn primary', 'NEXT LEVEL →');
    primaryBtn.type = 'button';
    primaryBtn.addEventListener('click', () => this.cb.onNextLevel());

    actions.append(ghostBtn, primaryBtn);
    this.win.append(
      this.winLvl,
      this.winComplete,
      divider,
      starsWrap,
      this.perfect,
      reward,
      actions,
    );

    // ------------------------------------------------------------- TOAST
    this.toastNode = el('div', 'toast');

    // ---------------------------------------------------------- CONFETTI
    this.confetti = el('div', 'confetti');

    // -------------------------------------------------------- MENU SHEET
    this.sheet = el('div', 'sheet');
    const card = el('div', 'card');
    const h2 = el('h2', undefined, 'FLOW CUBE');
    this.levelgrid = el('div', 'levelgrid');

    const resumeRow = el('div', 'row');
    resumeRow.append(el('span', undefined, 'Resume'), el('span', undefined, '✕'));
    resumeRow.addEventListener('click', () => this.closeSheet());

    card.append(h2, this.levelgrid, resumeRow);
    // Prevent backdrop close when interacting with the card itself.
    card.addEventListener('click', (e) => e.stopPropagation());
    this.sheet.appendChild(card);
    this.sheet.addEventListener('click', () => this.closeSheet());

    // ------------------------------------------------------------- MOUNT
    this.root.append(
      topbar,
      spacer,
      bottombar,
      this.centerHint,
      this.objective,
      this.win,
      this.toastNode,
      this.confetti,
      this.sheet,
    );
  }

  // ------------------------------------------------------------- builders
  private makeTool(svg: string, label: string, onClick: () => void): HTMLElement {
    const tool = el('button', 'tool');
    tool.type = 'button';
    const icon = el('span');
    icon.innerHTML = svg;
    tool.append(icon.firstElementChild ?? icon, el('span', 'lbl', label));
    tool.addEventListener('click', onClick);
    return tool;
  }

  private onCounterClick(): void {
    // During play the counter is the hint bulb; clicking spends a hint.
    if (this.counterIco.classList.contains('bulb')) this.cb.onHint();
  }

  // ------------------------------------------------------------- counter
  private showBulb(n: number): void {
    this.counterIco.className = 'ico bulb';
    this.counterIco.textContent = '💡';
    this.counterNum.textContent = String(n);
  }

  private showGem(n: number): void {
    this.counterIco.className = 'ico gem';
    this.counterIco.textContent = '💎';
    this.counterNum.textContent = String(n);
  }

  // ------------------------------------------------------------- public API
  loadLevel(v: LevelView): void {
    this.view = v;

    this.levelTitle.textContent = 'LEVEL ' + v.number;
    this.winLvl.textContent = 'LEVEL ' + v.number;

    // Reset to base PLAY state.
    this.app.classList.remove('state-mid', 'state-win');

    // Timer reset.
    this.setTimer(0);

    // Counter shows the hint bulb during play.
    this.showBulb(v.hints);

    // Reset progress dots from the completed/total info; start empty.
    this.setProgress(0, 0);

    // Hide win + confetti + center hint.
    this.hideWinInternal();
    this.centerHint.classList.remove('show');

    // Show objective, then fade it out after a few seconds.
    this.objective.style.opacity = '1';
    if (this.objectiveTimer) clearTimeout(this.objectiveTimer);
    this.objectiveTimer = window.setTimeout(() => {
      this.objective.style.opacity = '0';
    }, 4000);

    this.rebuildLevelGrid(v);
    this.closeSheet();
  }

  enterMid(): void {
    this.app.classList.add('state-mid');
    this.centerHint.classList.add('show');
  }

  setTimer(seconds: number): void {
    this.timerText.textContent = fmtTime(seconds);
  }

  setProgress(filled: number, total: number): void {
    const safeTotal = Math.max(0, Math.floor(total));
    const safeFilled = Math.max(0, Math.min(filled, safeTotal));

    // Reconcile the dot count without rebuilding when possible.
    while (this.dots.children.length < safeTotal) {
      this.dots.appendChild(el('div', 'dot'));
    }
    while (this.dots.children.length > safeTotal) {
      this.dots.removeChild(this.dots.lastChild as ChildNode);
    }
    for (let i = 0; i < this.dots.children.length; i++) {
      const dot = this.dots.children[i] as HTMLElement;
      dot.className = i < safeFilled ? 'dot on' : 'dot';
    }
  }

  setHints(n: number): void {
    if (this.counterIco.classList.contains('bulb')) {
      this.counterNum.textContent = String(n);
    }
  }

  toast(msg: string): void {
    this.toastNode.textContent = msg;
    this.toastNode.classList.add('show');
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => {
      this.toastNode.classList.remove('show');
    }, 1400);
  }

  dismissHints(): void {
    this.centerHint.classList.remove('show');
    this.objective.style.opacity = '0';
    if (this.objectiveTimer) {
      clearTimeout(this.objectiveTimer);
      this.objectiveTimer = 0;
    }
  }

  showWin(stars: number, gemsAwarded: number, gemsTotal: number): void {
    const lit = Math.max(0, Math.min(3, Math.floor(stars)));

    this.app.classList.remove('state-mid');
    this.app.classList.add('state-win');

    this.winComplete.textContent = 'COMPLETE!';
    this.perfect.textContent =
      lit === 3 ? 'PERFECT FLOW!' : lit === 2 ? 'GREAT FLOW!' : 'LEVEL CLEAR!';
    this.rewardNum.textContent = '+' + gemsAwarded;

    // Top-right counter swaps to the gem total during the win screen.
    this.showGem(gemsTotal);

    // Reset stars, then stagger the lit pops.
    this.clearStarTimers();
    for (let i = 0; i < this.stars.length; i++) {
      this.stars[i].classList.remove('lit');
    }
    for (let i = 0; i < lit; i++) {
      const star = this.stars[i];
      const t = window.setTimeout(() => {
        star.classList.add('lit');
      }, 350 + i * 260);
      this.starTimers.push(t);
    }

    this.win.classList.add('show');
    this.spawnConfetti();
  }

  hideWin(): void {
    this.hideWinInternal();
    this.app.classList.remove('state-win', 'state-mid');
  }

  // ------------------------------------------------------------- internals
  private hideWinInternal(): void {
    this.win.classList.remove('show');
    this.confetti.classList.remove('show');
    this.confetti.replaceChildren();
    this.clearStarTimers();
    for (const star of this.stars) star.classList.remove('lit');
  }

  private clearStarTimers(): void {
    for (const t of this.starTimers) clearTimeout(t);
    this.starTimers.length = 0;
  }

  private spawnConfetti(): void {
    this.confetti.replaceChildren();
    const frag = document.createDocumentFragment();
    for (let i = 0; i < CONFETTI_COUNT; i++) {
      const piece = el('i');
      const color = CONFETTI_COLORS[(Math.random() * CONFETTI_COLORS.length) | 0];
      piece.style.left = (Math.random() * 100).toFixed(2) + '%';
      piece.style.background = color;
      piece.style.animationDuration = (2.2 + Math.random() * 2.4).toFixed(2) + 's';
      piece.style.animationDelay = (Math.random() * 0.8).toFixed(2) + 's';
      frag.appendChild(piece);
    }
    this.confetti.appendChild(frag);
    this.confetti.classList.add('show');
  }

  // ------------------------------------------------------------- menu sheet
  private rebuildLevelGrid(v: LevelView): void {
    this.levelgrid.replaceChildren();
    const frag = document.createDocumentFragment();
    for (let i = 0; i < v.totalLevels; i++) {
      const done = v.completedMask[i] === true;
      const lv = el('div', done ? 'lv done' : 'lv', String(i + 1));
      lv.addEventListener('click', (e) => {
        e.stopPropagation();
        this.cb.onSelectLevel(i);
        this.closeSheet();
      });
      frag.appendChild(lv);
    }
    this.levelgrid.appendChild(frag);
  }

  private openSheet(): void {
    if (this.view) this.rebuildLevelGrid(this.view);
    this.sheet.classList.add('show');
    this.cb.onMenu();
  }

  private closeSheet(): void {
    this.sheet.classList.remove('show');
  }
}
