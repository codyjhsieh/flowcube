import { buildSolved, LEVELS } from '../src/game/levels';
import { computeFlow } from '../src/game/Flow';

let ok = true;
for (const def of LEVELS) {
  const { cube } = buildSolved(def);
  const solvedFlow = computeFlow(cube);
  const { cube: scrambled } = cube.scramble(def.seed, def.scramble);
  const scrFlow = computeFlow(scrambled);

  const solvedOk = solvedFlow.solved;
  // a good level should NOT already be solved after scrambling (most of the time)
  const scrambledTrivial = scrFlow.solved;

  if (!solvedOk) ok = false;
  console.log(
    `L${def.id} "${def.name}" n=${def.n} scr=${def.scramble} ` +
      `solvedState=${solvedOk ? 'OK' : 'FAIL'} ` +
      `(${solvedFlow.reachedSinks.length}/${solvedFlow.totalSinks}) | ` +
      `afterScramble reached=${scrFlow.reachedSinks.length}/${scrFlow.totalSinks}` +
      (scrambledTrivial ? '  <-- trivial!' : '')
  );
}
console.log(ok ? '\nALL SOLVED STATES VALID' : '\nSOME LEVELS INVALID');
process.exit(ok ? 0 : 1);
