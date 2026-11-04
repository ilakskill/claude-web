// Preset table of the agent CLIs cw can start, and the pure helpers around it. Written as a plain
// script (like recent-filter.js) so the hub, the CLI and the web pages share one copy: the hub
// serves it as /app/harnesses.js and Node reads globalThis.cwHarnesses after a side-effect import.
(function (root) {
  'use strict';

  // models: how the hub finds the model list (src/hub/models.js). hooks: which hook channel the
  // harness has ('claude' | 'gemini' | 'codex' | null); null harnesses get bell/OSC pushes by default.
  const HARNESSES = Object.freeze([
    { id: 'claude', label: 'Claude Code', command: 'claude', args: [], modelFlag: ['--model'], continueArgs: ['--continue'], resumeArgs: (id) => ['--resume', id], hooks: 'claude', models: { kind: 'static', list: ['sonnet', 'opus', 'haiku'] } },
    { id: 'agy', label: 'Antigravity', command: 'agy', args: [], modelFlag: ['--model'], continueArgs: ['--continue'], resumeArgs: (id) => ['--conversation', id], hooks: null, models: { kind: 'command', argv: ['models'], parse: 'tsv' } },
    { id: 'copilot', label: 'GitHub Copilot', command: 'copilot', args: [], modelFlag: ['--model'], continueArgs: ['--continue'], resumeArgs: (id) => ['--resume', id], hooks: null, models: { kind: 'command', argv: ['help', 'config'], parse: 'copilot-config' } },
    { id: 'gemini', label: 'Gemini CLI', command: 'gemini', args: [], modelFlag: ['-m'], continueArgs: ['--resume', 'latest'], resumeArgs: null, hooks: 'gemini', models: { kind: 'static', list: [] } },
    { id: 'codex', label: 'Codex', command: 'codex', args: ['--no-daemon'], modelFlag: ['-m'], continueArgs: ['resume', '--last'], resumeArgs: (id) => ['resume', id], hooks: 'codex', models: { kind: 'file', path: '~/.codex/config.toml', parse: 'toml-model' } },
    { id: 'opencode', label: 'OpenCode', command: 'opencode', args: [], modelFlag: ['-m'], continueArgs: ['--continue'], resumeArgs: (id) => ['--session', id], hooks: null, models: { kind: 'command', argv: ['models'], parse: 'lines', fallback: { kind: 'file', path: '~/.config/opencode/opencode.json', parse: 'opencode-json' } } },
    // NVIDIA hosted models through OpenCode's built-in `nvidia` provider (OpenAI-compatible endpoint
    // integrate.api.nvidia.com/v1). The key is only ever read from NVIDIA_API_KEY in the hub's environment.
    { id: 'nvidia', label: 'NVIDIA (OpenCode)', command: 'opencode', args: [], modelFlag: ['-m'], defaultModel: 'nvidia/nvidia/nemotron-3-ultra-550b-a55b', requiresEnv: 'NVIDIA_API_KEY', continueArgs: ['--continue'], resumeArgs: (id) => ['--session', id], hooks: null, models: { kind: 'nvidia' } },
    { id: 'hermes', label: 'Hermes', command: 'hermes', args: [], modelFlag: ['-m'], continueArgs: ['--continue'], resumeArgs: (id) => ['--resume', id], hooks: null, models: { kind: 'file', path: '~/.hermes/config.yaml', parse: 'hermes-yaml' } },
    { id: 'pi', label: 'pi', command: 'pi', args: [], modelFlag: ['--model'], continueArgs: ['--continue'], resumeArgs: (id) => ['--session', id], hooks: null, models: { kind: 'command', argv: ['--list-models'], parse: 'pi-table' } },
    { id: 'ollama', label: 'Ollama', command: 'ollama', args: ['run'], modelFlag: 'positional', modelRequired: true, continueArgs: null, resumeArgs: null, hooks: null, models: { kind: 'http', url: 'http://127.0.0.1:11434/api/tags', fallback: { kind: 'command', argv: ['list'], parse: 'ollama-list' } } },
    { id: 'shell', label: 'PowerShell', command: 'pwsh', args: ['-NoLogo'], modelFlag: null, continueArgs: null, resumeArgs: null, hooks: null, models: null },
  ]);

  const MODEL_MAX = 100;

  function getHarness(id) {
    return HARNESSES.find((h) => h.id === id) || null;
  }

  /** The command's short name (`pwsh`, `claude`), without directory or .exe/.cmd/.bat. */
  function baseName(command) {
    const s = String(command || '').replace(/[\\/]+$/, '');
    const base = s.slice(Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/')) + 1);
    return base.replace(/\.(exe|cmd|bat|com)$/i, '').toLowerCase();
  }

  /** The preset a command belongs to (by its short name), or null for a custom command. */
  function inferHarness(command) {
    const name = baseName(command);
    if (!name) return null;
    if (name === 'powershell') return getHarness('shell');
    return HARNESSES.find((h) => h.command === name) || null;
  }

  /** True for every preset except the plain shell. */
  function isAgent(h) {
    return !!h && h.id !== 'shell';
  }

  /** A valid model name: non-blank, at most MODEL_MAX characters, no control characters. */
  function validModel(m) {
    return typeof m === 'string' && m.trim() !== '' && m.length <= MODEL_MAX && !/[\x00-\x1f\x7f]/.test(m);
  }

  /**
   * argv for a harness: preset args (or `presetArgs`), then the continue/resume arguments, then the
   * model, then the user's own. Throws Error (message safe to show) for combinations the harness
   * cannot do.
   * @param {object} h a HARNESSES entry
   * @param {{model?:string, args?:string[], continue?:boolean, resumeId?:string, presetArgs?:string[]}} [o]
   */
  function buildArgs(h, o = {}) {
    if (!h) throw new Error('unknown harness');
    const { model, args = [], presetArgs } = o;
    if (o.continue && o.resumeId) throw new Error('continue and resume cannot be combined');
    const out = [...(presetArgs || h.args)];
    if (o.continue) {
      if (!h.continueArgs) throw new Error(`${h.label} cannot continue a previous session`);
      out.push(...h.continueArgs);
    } else if (o.resumeId) {
      if (!h.resumeArgs) throw new Error(`${h.label} cannot resume a session by id`);
      out.push(...h.resumeArgs(o.resumeId));
    }
    const given = model !== undefined && model !== null && model !== '';
    // defaultModel applies to a fresh start only; continue/resume keep the earlier conversation's model.
    const useModel = given ? model : (h.defaultModel && !o.continue && !o.resumeId ? h.defaultModel : undefined);
    const hasModel = useModel !== undefined;
    if (given && !validModel(model)) throw new Error('model is not valid');
    if (h.modelRequired && !hasModel) throw new Error(`${h.label} needs a model`);
    if (hasModel) {
      if (!h.modelFlag) throw new Error(`${h.label} has no model option`);
      if (h.modelFlag === 'positional') out.push(useModel);
      else out.push(...h.modelFlag, useModel);
    }
    out.push(...args);
    return out;
  }

  /**
   * argv for POST /api/sessions. A body with a custom `command` and no `harness` is the legacy API:
   * `--resume <id>` (if any) in front of the caller's own args, no preset checks, even when the
   * command's name matches a preset (that only records the inferred harness id). Otherwise the
   * harness (explicit, or the default) goes through buildArgs. Throws Error (safe message).
   * @param {{harnessId?:string|null, command?:string|null, harness:object|null, resume?:string, model?:string|null, continue?:boolean, args?:string[], presetArgs?:string[]}} o
   */
  function buildSessionArgs(o) {
    const { harnessId, command, harness, resume, model, args = [] } = o;
    const legacy = !harnessId && !!command;
    const argHarness = (!harnessId && resume) ? getHarness('claude') : harness;
    if (legacy || !argHarness) {
      if ((model ?? null) !== null || o.continue === true) throw new Error('model and continue need a harness');
      return [...(resume ? ['--resume', resume] : []), ...args];
    }
    return buildArgs(argHarness, {
      presetArgs: o.presetArgs, model: model ?? undefined, continue: o.continue === true, resumeId: resume || undefined, args,
    });
  }

  /** Short label for rows and `cw ls`: the preset's label, else the command's short name. */
  function displayLabel(entry) {
    if (!entry) return '';
    const h = getHarness(entry.harness) || inferHarness(entry.command);
    return h ? h.label : baseName(entry.command);
  }

  root.cwHarnesses = Object.freeze({ HARNESSES, MODEL_MAX, getHarness, inferHarness, isAgent, validModel, buildArgs, buildSessionArgs, displayLabel, baseName });
})(globalThis);
