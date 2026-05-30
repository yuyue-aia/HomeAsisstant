import { discoverSkills, loadAllSkillBodies } from '../src/agent/skills/skill-loader';
import { buildSystemPrompt } from '../src/agent/system-prompt-builder';

const runs = 3;
console.log('--- eager mode ---');
for (let i = 0; i < runs; i++) {
  const skills = discoverSkills();
  const skillsFull = loadAllSkillBodies(skills);
  const r = buildSystemPrompt({ mode: 'eager', skills, skillsFull });
  console.log(
    `run #${i + 1}: bytes=${r.bytes}, hash=${r.fingerprint}, skills=${skills
      .map((s) => s.name)
      .join(',')}`,
  );
}

console.log('--- lazy mode ---');
for (let i = 0; i < runs; i++) {
  const skills = discoverSkills();
  const r = buildSystemPrompt({ mode: 'lazy', skills });
  console.log(
    `run #${i + 1}: bytes=${r.bytes}, hash=${r.fingerprint}, skills=${skills
      .map((s) => s.name)
      .join(',')}`,
  );
}
