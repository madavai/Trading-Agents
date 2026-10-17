// The desk's agent files as the project ships them: each path (relative to the repository) and its text. One source for
// `npm run agents`, which writes them, and for the desk tool server, whose desk check says when the files in a folder
// differ from these and whose reset_team tool writes these back (a save in Madav's Agent Studio can rewrite them).
import { AGENTS, render } from './agents-src.mjs';
import { teamFiles } from './team-src.mjs';

export function deskAgentFiles() {
  const files = new Map(AGENTS.map((a) => [`.claude/agents/${a.file}.md`, render(a)]));
  for (const [p, text] of teamFiles()) files.set(p, text);
  return files;
}
