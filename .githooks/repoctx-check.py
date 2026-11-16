#!/usr/bin/env python3
"""The repo-context kit's change checker: one model-free gate for features, change records and old terms.

Standard library only and a single file, so `install` can copy it into a repo as `.githooks/repoctx-check.py`
and the hooks there work offline without the kit. The same file runs in Ava's gates (agent loop finish, the
coordinator thread report, the Hive merge), the pre-push hook and the Claude Code Stop hook.

    repoctx-check.py check [--base REF] [--branch NAME] [--head REF] [--json]
    repoctx-check.py features [--json]          is features.json valid and complete
    repoctx-check.py diff [--base REF] [--json] which features the change touches, and what it adds
    repoctx-check.py graph [--json]             imports, symbols, renders, strings and settings per file
    repoctx-check.py strings [--json]           user-visible strings written in more than one file
    repoctx-check.py label TEXT [--json]        where a label already exists (reuse it before writing a new one)
    repoctx-check.py reuse PATH [--json]        for new text on stdin (going into PATH): its labels that already exist
    repoctx-check.py install [--dry-run] [--json] [--fill-features]
    repoctx-check.py hook pre-push|stop         used by the installed hooks

All take --repo PATH (default: the git repository of the current directory).

Files it reads, all under `.claude/context/`:

    features.json          [{"id", "summary", "paths", "terms"?, "notes"?, "screens"?: [{"name", "path"?, "open"?}],
                             "routes"?: [str], "menu"?: [str], "settings"?: [str]}]
    changes/<branch>.json  {"summary", "features": [id], "changes": [{"old", "new"}], "spots": [{"path", "note"?}],
                            "kept": [{"term", "path"?, "reason"}]}
    kit.json (optional)    {"surfaces": {"screen": [glob], "route": [pattern], "menu": [pattern], "setting": [pattern]},
                            "allowed": [glob], "ignore": [glob], "screens": {...}}
                           A pattern is a regex, or {"pattern", "files": [glob]} to look only in those files.
                           A kind listed in kit.json replaces that kind's defaults.

Exit codes: 0 passed, 1 findings that block, 2 usage or repository error.
"""
import argparse
import fnmatch
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys

CHECKER_VERSION = 1
CONTEXT = ".claude/context"
FEATURES = CONTEXT + "/features.json"
CHANGES = CONTEXT + "/changes"
KIT_CONFIG = CONTEXT + "/kit.json"
CACHE = CONTEXT + "/.cache/graph.json"
OVERRIDE = "repoctx-override.json"
STOP_STATE = "repoctx-stop.json"
MAINS = ("main", "master")
ZERO_SHA = "0" * 40
STOP_BLOCK_LIMIT = 3
MAX_FILE_BYTES = 1_000_000
MIN_TERM = 3
MIN_SYMBOL = 4
MAX_STRING = 160
# Key names in keyboard handlers, not labels.
KEY_NAMES = {"Escape", "Enter", "Tab", "Backspace", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space",
             "Shift", "Control", "Alt", "Meta", "PageUp", "PageDown"}
GATE_MARK = "<!-- repoctx-gates -->"
GATE_END = "<!-- /repoctx-gates -->"
HOOKS_DIR = ".githooks"
HOOK_SCRIPT = "repoctx-check.py"

CODE_EXT = {".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte", ".rs", ".py", ".go", ".java", ".kt",
            ".swift", ".cs", ".rb", ".php", ".dart"}
TEXT_EXT = {".md", ".mdx", ".txt", ".html", ".htm", ".json", ".yml", ".yaml", ".toml"}
UI_EXT = {".tsx", ".jsx", ".vue", ".svelte", ".html"}
JS_EXT = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte"]
LOCKFILES = {"package-lock.json", "yarn.lock", "pnpm-lock.yaml", "Cargo.lock", "poetry.lock", "Gemfile.lock",
             "composer.lock", "bun.lockb", "go.sum"}
SKIP_PARTS = {"node_modules", "target", "dist", "build", ".git", ".venv", "venv", "__pycache__", ".next", "coverage",
              "out", ".turbo", ".expo", "vendor"}
GENERATED = ["**/gen/**", "**/*.min.js", "**/*.generated.*", "**/__snapshots__/**", ".githooks/**"]
TEST_GLOBS = ["**/*.test.*", "**/*.spec.*", "**/*_test.*", "**/test_*.py", "**/tests/**", "**/__tests__/**",
              "**/e2e/**", "**/fixtures/**"]

DEFAULT_SURFACES = {
    "screen": ["**/*Page.tsx", "**/*Page.jsx", "**/*Page.vue", "**/*Page.svelte", "**/*Screen.tsx", "**/*Screen.jsx",
               "**/pages/**/*.tsx", "**/pages/**/*.jsx", "**/pages/**/*.vue", "**/screens/**/*.tsx",
               "**/app/**/page.tsx", "**/app/**/page.jsx"],
    "route": [r"<Route\b[^>]*\bpath=[\"']([^\"']+)", r"\bpath:\s*['\"](/[^'\"]*)['\"]",
              r"\b(?:router|app)\.(?:get|post|put|patch|delete)\(\s*['\"](/[^'\"]*)",
              r"@(?:Get|Post|Put|Patch|Delete)\(\s*['\"]([^'\"]+)", r"#\[(?:get|post|put|patch|delete)\(\"([^\"]+)\""],
    # Navigation entries in UI files only: backend lists and option lists elsewhere are not menus.
    "menu": [{"pattern": r"\{\s*id:\s*['\"][\w-]+['\"]\s*,\s*label:\s*['\"]([^'\"]+)['\"]",
              "files": ["**/*.tsx", "**/*.jsx", "**/*.vue", "**/*.svelte"]},
             r"<(?:MenuItem|NavItem|NavLink|Tab)\b[^>]*>\s*([A-Za-z][^<{]{1,40}?)\s*<"],
    "setting": [r"localStorage\.(?:getItem|setItem|removeItem)\(\s*['\"]([^'\"]+)['\"]",
                r"\bgetSetting\(\s*['\"]([\w.-]+)['\"]"],
}

GATE_RULE = """{mark}
## Change gates (repo-context kit)

Before you report work done or land it on main:

- Every screen, route, menu item or setting you add is listed in `.claude/context/features.json`.
- Write `.claude/context/changes/<branch>.json`: the features you touched, every spot you changed, each renamed
  or removed term (`changes: [{{old, new}}]`) and any old term kept on purpose (`kept: [{{term, path, reason}}]`).
- `python .githooks/repoctx-check.py check` must pass. The pre-push hook (pushes and fast-forwards to main or
  master) and the Claude Code Stop hook run it. Never bypass them: no `--no-verify`, no editing the hooks, no
  writing `.git/repoctx-override.json`. Only Nate overrides a gate, from Ava's Inbox.
{end}
"""

PRE_PUSH = """#!/bin/sh
# repo-context kit gate: pushes and fast-forwards to main or master wait for the change check.
# Installed by `repoctx-check.py install`; see .claude/context/ and the gate rule in AGENTS.md.
PY=python3
"$PY" -c "" 2>/dev/null || PY=python
exec "$PY" "$(git rev-parse --show-toplevel)/.githooks/repoctx-check.py" hook pre-push "$@"
"""

# Portable: python3 where it runs (Linux, macOS, cloud sessions), else python (Windows), from the
# project root Claude Code passes in, so the hook works from any working directory and needs no Ava.
STOP_COMMAND = ('PY=python3; "$PY" -c "" 2>/dev/null || PY=python; '
                'D="${CLAUDE_PROJECT_DIR:-.}"; "$PY" "$D/.githooks/repoctx-check.py" --repo "$D" hook stop')
# The hook is a shell script: a CRLF checkout (core.autocrlf on Windows) would break it.
HOOK_ATTRIBUTES = ".githooks/** text eol=lf"


# ---------------------------------------------------------------- repository

class RepoError(Exception):
    pass


def git(root, *args, check=True):
    proc = subprocess.run(["git", "-C", root, *args], capture_output=True, text=True, encoding="utf-8",
                          errors="replace")
    if check and proc.returncode != 0:
        raise RepoError("git %s: %s" % (" ".join(args), proc.stderr.strip() or proc.stdout.strip()))
    return proc.stdout


def repo_root(path=None):
    start = os.path.abspath(path or os.getcwd())
    proc = subprocess.run(["git", "-C", start, "rev-parse", "--show-toplevel"], capture_output=True, text=True)
    if proc.returncode != 0:
        raise RepoError("%s is not inside a git repository" % start)
    return os.path.normpath(proc.stdout.strip())


def git_dir(root):
    return os.path.normpath(os.path.join(root, git(root, "rev-parse", "--git-dir").strip()))


def current_branch(root):
    name = git(root, "rev-parse", "--abbrev-ref", "HEAD", check=False).strip()
    return "" if name == "HEAD" else name


def rev(root, ref):
    return git(root, "rev-parse", "--verify", "--quiet", ref + "^{commit}", check=False).strip()


def is_ancestor(root, older, newer):
    return subprocess.run(["git", "-C", root, "merge-base", "--is-ancestor", older, newer],
                          capture_output=True).returncode == 0


# Branches work is cut from: the mains, and an integration branch where a repo has one.
BASE_BRANCHES = MAINS + ("dev", "develop")


def default_base(root, head="HEAD"):
    """Where this branch's work starts: the newest commit it shares with a main or integration
    branch, local or origin/ (a stale local main, or a branch cut from dev, would otherwise count
    every commit since an old point as this branch's change)."""
    bases = []
    for name in BASE_BRANCHES:
        for ref in (name, "origin/" + name):
            if rev(root, ref):
                base = git(root, "merge-base", head, ref, check=False).strip()
                if base and base not in bases:
                    bases.append(base)
    for base in bases:
        if all(other == base or is_ancestor(root, other, base)
               for other in bases):
            return base
    return bases[0] if bases else ""


def read_json(root, rel, default):
    try:
        with open(os.path.join(root, rel), encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return default


def write_text(root, rel, text):
    path = os.path.join(root, rel)
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)


def read_text(root, rel):
    try:
        with open(os.path.join(root, rel), "rb") as f:
            data = f.read(MAX_FILE_BYTES + 1)
    except OSError:
        return None
    if len(data) > MAX_FILE_BYTES or b"\0" in data[:4096]:
        return None
    return data.decode("utf-8", errors="replace")


def glob_regex(pattern):
    """`**/x/*.ts` style globs: `**/` is any folders (or none), `*` stays inside one folder."""
    out, i = "", 0
    while i < len(pattern):
        if pattern.startswith("**/", i):
            out += "(?:.*/)?"
            i += 3
        elif pattern.startswith("**", i):
            out += ".*"
            i += 2
        elif pattern[i] == "*":
            out += "[^/]*"
            i += 1
        elif pattern[i] == "?":
            out += "[^/]"
            i += 1
        else:
            out += re.escape(pattern[i])
            i += 1
    return re.compile("^" + out + "$", re.IGNORECASE)


def matches_any(path, globs):
    return any(glob_regex(g).match(path) for g in globs)


def is_test(path):
    return matches_any(path, TEST_GLOBS)


def _pattern(entry):
    """(regex, globs or None) from a surface pattern: a regex string, or {"pattern", "files"}."""
    if isinstance(entry, dict):
        return entry.get("pattern", ""), list(entry.get("files") or []) or None
    return entry, None


def kit_config(root):
    config = read_json(root, KIT_CONFIG, {}) or {}
    own = config.get("surfaces") or {}
    surfaces = {kind: list(own[kind]) if kind in own else list(DEFAULT_SURFACES[kind]) for kind in DEFAULT_SURFACES}
    return {"surfaces": surfaces, "allowed": list(config.get("allowed", [])), "ignore": list(config.get("ignore", []))}


def repo_files(root, config=None):
    """Tracked and untracked (not ignored) text files, with forward slashes."""
    config = config or kit_config(root)
    out = git(root, "ls-files", "-co", "--exclude-standard", "-z")
    files = []
    for rel in sorted(set(filter(None, out.split("\0")))):
        rel = rel.replace("\\", "/")
        ext = os.path.splitext(rel)[1].lower()
        if ext not in CODE_EXT and ext not in TEXT_EXT:
            continue
        if any(part in SKIP_PARTS for part in rel.split("/")[:-1]) or os.path.basename(rel) in LOCKFILES:
            continue
        if rel.startswith(CONTEXT + "/.cache/") or matches_any(rel, GENERATED + config["ignore"]):
            continue
        if not os.path.isfile(os.path.join(root, rel)):
            continue
        files.append(rel)
    return files


# ---------------------------------------------------------------- dependency graph

JS_IMPORT = re.compile(r"""(?:\bimport|\bexport)\s[^'";]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\s*['"]([^'"]+)['"]"""
                       r"""|\brequire\(\s*['"]([^'"]+)['"]\s*\)|\bimport\(\s*['"]([^'"]+)['"]\s*\)""")
JS_NAMES = re.compile(r"""\bimport\s+(?:type\s+)?([\w$]+)?\s*,?\s*(?:\{([^}]*)\})?\s*from\s*['"]([^'"]+)['"]""")
JS_EXPORT = re.compile(r"\bexport\s+(?:default\s+)?(?:declare\s+)?(?:async\s+)?"
                       r"(?:function\*?|const|let|var|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)")
RS_MOD = re.compile(r"^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)\s*;", re.M)
RS_USE = re.compile(r"\b(?:use\s+)?crate::(\w+)(?:::(\w+))?")
RS_EXPORT = re.compile(r"^\s*pub(?:\([^)]*\))?\s+(?:async\s+)?(?:unsafe\s+)?(?:fn|struct|enum|trait|type|const|static)\s+"
                       r"(\w+)", re.M)
PY_FROM = re.compile(r"^\s*from\s+(\.+[\w.]*|[\w.]+)\s+import\b", re.M)
PY_IMPORT = re.compile(r"^\s*import\s+([\w.]+)", re.M)
PY_EXPORT = re.compile(r"^(?:async\s+)?(?:def|class)\s+([A-Za-z]\w*)", re.M)
JSX_TAG = re.compile(r"<([A-Z][A-Za-z0-9]*)[\s/>]")
# Text between tags. Not `=>` arrows, and not a type name right before its generic (`Promise<void>`).
JSX_TEXT = re.compile(r"(?<![=\-])>\s*([^<>{}\n]*[A-Za-z][^<>{}\n]*?)\s*<(?![A-Za-z_]\w*>)(?=/|[A-Za-z])")
STRING_LIT = re.compile(r"""'((?:[^'\\\n]|\\.){2,%d})'|"((?:[^"\\\n]|\\.){2,%d})"|`((?:[^`\\$]|\\.){2,%d})`"""
                        % (MAX_STRING, MAX_STRING, MAX_STRING))
IDENT = re.compile(r"[A-Za-z_][A-Za-z0-9_]{%d,}" % (MIN_SYMBOL - 1))
COMMON_IDENTS = {"default", "string", "number", "boolean", "props", "state", "value", "error", "result", "index",
                 "items", "data", "type", "name", "path", "self", "true", "false", "null", "none", "async", "await",
                 "const", "return", "import", "export", "from", "function", "class", "struct", "impl"}


def _resolve_js(rel, spec, files):
    if spec.startswith("@/"):
        base = "src/" + spec[2:]
    elif spec.startswith("."):
        base = os.path.normpath(os.path.join(os.path.dirname(rel), spec)).replace("\\", "/")
    else:
        return None
    for cand in [base] + [base + ext for ext in JS_EXT + [".css", ".json"]] + [base + "/index" + ext for ext in JS_EXT]:
        if cand in files:
            return cand
    return None


def _crate_src(rel):
    parts = rel.split("/")
    for i in range(len(parts) - 1, -1, -1):
        if parts[i] == "src":
            return "/".join(parts[:i + 1])
    return os.path.dirname(rel)


def _resolve_rs_mod(rel, name, files):
    folder, stem = os.path.dirname(rel), os.path.splitext(os.path.basename(rel))[0]
    base = folder if stem in ("mod", "lib", "main") else (folder + "/" + stem if folder else stem)
    for cand in (base + "/" + name + ".rs", base + "/" + name + "/mod.rs"):
        cand = cand.lstrip("/")
        if cand in files:
            return cand
    return None


def _resolve_rs_use(rel, first, second, files):
    src = _crate_src(rel)
    cands = []
    if second:
        cands += [src + "/" + first + "/" + second + ".rs", src + "/" + first + "/" + second + "/mod.rs"]
    cands += [src + "/" + first + ".rs", src + "/" + first + "/mod.rs"]
    for cand in cands:
        if cand in files:
            return cand
    return None


def _resolve_py(rel, spec, files):
    if spec.startswith("."):
        dots = len(spec) - len(spec.lstrip("."))
        folder = os.path.dirname(rel)
        for _ in range(dots - 1):
            folder = os.path.dirname(folder)
        base = (folder + "/" if folder else "") + spec.lstrip(".").replace(".", "/")
    else:
        base = spec.replace(".", "/")
    for cand in (base + ".py", base + "/__init__.py"):
        if cand.lstrip("/") in files:
            return cand.lstrip("/")
    return None


def _visible(text):
    """A string a person reads: words with a letter, not a path, URL, class list, key or format pattern."""
    text = text.strip()
    if len(text) < 2 or len(text) > MAX_STRING or not re.search(r"[A-Za-z]", text):
        return False
    if re.search(r"://|\\|^[./#@]|[{}<>=;]|&&|\|\||^\w+[.:]\w|%[sd]", text):
        return False
    words = text.split()
    if all(re.fullmatch(r"[a-z0-9_-]+", w) for w in words) and (len(words) > 1 or "-" in text or "_" in text):
        return False
    if len(words) == 1 and (not text[0].isupper() or re.fullmatch(r"[A-Z0-9_]{3,}", text) or text in KEY_NAMES):
        return False
    return True


def _strings(rel, text):
    out = []
    ext = os.path.splitext(rel)[1].lower()
    for number, line in enumerate(text.splitlines(), 1):
        stripped = line.strip()
        if stripped.startswith(("import ", "export * from", "use ", "#include", "//", "#[", "*", "/*")):
            continue
        for m in STRING_LIT.finditer(line):
            value = next(g for g in m.groups() if g is not None)
            if _visible(value):
                out.append({"text": value.strip(), "line": number})
        if ext in UI_EXT:
            for m in JSX_TEXT.finditer(line):
                if _visible(m.group(1)):
                    out.append({"text": m.group(1).strip(), "line": number})
    return out


def _settings(text, patterns, rel=""):
    out = []
    for number, line in enumerate(text.splitlines(), 1):
        for entry in patterns:
            pattern, files = _pattern(entry)
            if files and not matches_any(rel, files):
                continue
            for m in re.finditer(pattern, line):
                out.append({"key": m.group(1), "line": number})
    return out


def parse_file(rel, text, files, config):
    ext = os.path.splitext(rel)[1].lower()
    node = {"imports": [], "symbols": [], "renders": [], "strings": [], "settings": [], "idents": []}
    if ext in CODE_EXT:
        if ext in JS_EXT:
            for m in JS_IMPORT.finditer(text):
                spec = next(g for g in m.groups() if g)
                target = _resolve_js(rel, spec, files)
                if target:
                    node["imports"].append(target)
            node["symbols"] = sorted(set(JS_EXPORT.findall(text)))
            if ext in UI_EXT:
                names = {}
                for m in JS_NAMES.finditer(text):
                    target = _resolve_js(rel, m.group(3), files)
                    if not target:
                        continue
                    if m.group(1):
                        names[m.group(1)] = target
                    for part in (m.group(2) or "").split(","):
                        part = part.strip().replace("type ", "")
                        if part:
                            names[part.split(" as ")[-1].strip()] = target
                local = set(node["symbols"])
                for tag in sorted(set(JSX_TAG.findall(text))):
                    if tag in names:
                        node["renders"].append({"component": tag, "file": names[tag]})
                    elif tag in local:
                        node["renders"].append({"component": tag, "file": rel})
        elif ext == ".rs":
            for m in RS_MOD.finditer(text):
                target = _resolve_rs_mod(rel, m.group(1), files)
                if target:
                    node["imports"].append(target)
            for m in RS_USE.finditer(text):
                target = _resolve_rs_use(rel, m.group(1), m.group(2), files)
                if target and target != rel:
                    node["imports"].append(target)
            node["symbols"] = sorted(set(RS_EXPORT.findall(text)))
        elif ext == ".py":
            for spec in PY_FROM.findall(text) + PY_IMPORT.findall(text):
                target = _resolve_py(rel, spec, files)
                if target:
                    node["imports"].append(target)
            node["symbols"] = sorted(set(n for n in PY_EXPORT.findall(text) if not n.startswith("_")))
        node["imports"] = sorted(set(node["imports"]) - {rel})
        node["strings"] = _strings(rel, text)
        node["idents"] = sorted(set(IDENT.findall(text)) - COMMON_IDENTS)
    node["settings"] = _settings(text, config["surfaces"]["setting"], rel)
    return node


EXTERNAL_GRAPHS = ["madge.json", "dependency-cruiser.json", "depcruise.json", "dependency-graph.json",
                   "reports/madge.json", "reports/dependency-cruiser.json"]


def external_edges(root, files):
    """Import edges from a dependency-cruiser or madge JSON report the repo already has (nothing is installed
    or run): dependency-cruiser's {"modules": [{"source", "dependencies": [{"resolved"}]}]} or madge's
    {"file": ["dependency", ...]}. Edges whose ends are not repo files are dropped."""
    edges = {}
    for rel in EXTERNAL_GRAPHS:
        try:
            data = read_json(root, rel, None)
        except ValueError:
            continue
        if isinstance(data, dict) and isinstance(data.get("modules"), list):
            pairs = [(m.get("source"), d.get("resolved")) for m in data["modules"] if isinstance(m, dict)
                     for d in m.get("dependencies", []) or [] if isinstance(d, dict)]
        elif isinstance(data, dict):
            pairs = [(src, dep) for src, deps in data.items() if isinstance(deps, list) for dep in deps]
        else:
            continue
        for src, dep in pairs:
            if isinstance(src, str) and isinstance(dep, str):
                src, dep = src.replace("\\", "/").lstrip("./"), dep.replace("\\", "/").lstrip("./")
                if src in files and dep in files and src != dep:
                    edges.setdefault(src, set()).add(dep)
    return edges


def build_graph(root, config=None, use_cache=True):
    """Per-file imports, exported symbols, rendered components, visible strings and settings keys, plus who
    imports and who references each file. Cached per file by size and mtime under `.claude/context/.cache/`,
    only in repos that already have `.claude/context/` (so a dry run leaves nothing behind)."""
    config = config or kit_config(root)
    use_cache = use_cache and os.path.isdir(os.path.join(root, CONTEXT))
    files = repo_files(root, config)
    fileset = set(files)
    cache = read_json(root, CACHE, {}) if use_cache else {}
    if cache.get("version") != CHECKER_VERSION:
        cache = {}
    old = cache.get("files", {})
    nodes, stamps = {}, {}
    for rel in files:
        st = os.stat(os.path.join(root, rel))
        stamp = "%d:%d" % (st.st_size, int(st.st_mtime))
        hit = old.get(rel)
        if hit and hit.get("stamp") == stamp:
            nodes[rel] = hit["node"]
        else:
            text = read_text(root, rel)
            nodes[rel] = parse_file(rel, text or "", fileset, config) if text is not None else {
                "imports": [], "symbols": [], "renders": [], "strings": [], "settings": [], "idents": []}
        stamps[rel] = stamp
    if use_cache:
        try:
            write_text(root, CACHE, json.dumps({"version": CHECKER_VERSION, "files": {
                rel: {"stamp": stamps[rel], "node": nodes[rel]} for rel in files}}))
        except OSError:
            pass
    for src, deps in external_edges(root, fileset).items():
        nodes[src] = dict(nodes[src], imports=sorted(set(nodes[src]["imports"]) | deps))
    importers = {}
    for rel, node in nodes.items():
        for target in node["imports"]:
            importers.setdefault(target, []).append(rel)
    users = {}
    owners = {}
    for rel, node in nodes.items():
        for name in node["symbols"]:
            if len(name) >= MIN_SYMBOL and name not in COMMON_IDENTS:
                owners.setdefault(name, set()).add(rel)
    for rel, node in nodes.items():
        for ident in node["idents"]:
            for owner in owners.get(ident, ()):
                if owner != rel:
                    users.setdefault(owner, set()).add(rel)
    return {"version": CHECKER_VERSION, "files": nodes,
            "importers": {k: sorted(v) for k, v in importers.items()},
            "users": {k: sorted(v) for k, v in users.items()}}


def graph_summary(graph):
    nodes = graph["files"]
    return {"files": len(nodes), "imports": sum(len(n["imports"]) for n in nodes.values()),
            "symbols": sum(len(n["symbols"]) for n in nodes.values()),
            "renders": sum(len(n["renders"]) for n in nodes.values()),
            "strings": sum(len(n["strings"]) for n in nodes.values()),
            "settings": sum(len(n["settings"]) for n in nodes.values())}


def shared_strings(graph, limit=50):
    """Visible strings written as separate literals in more than one non-test file: candidates for one shared
    label, most widely copied first."""
    where = {}
    for rel, node in graph["files"].items():
        if is_test(rel):
            continue
        for item in node["strings"]:
            key = item["text"].lower()
            where.setdefault(key, {"text": item["text"], "places": []})
            where[key]["places"].append("%s:%d" % (rel, item["line"]))
    rows = []
    for entry in where.values():
        files = sorted({p.rsplit(":", 1)[0] for p in entry["places"]})
        if len(files) > 1:
            rows.append({"text": entry["text"], "files": len(files), "places": entry["places"][:8]})
    rows.sort(key=lambda r: (-r["files"], r["text"].lower()))
    return rows[:limit]


def find_label(graph, text):
    """Where a label already exists: exact (case-insensitive) literals, and the named constants that hold it."""
    want = text.strip().lower()
    places, constants = [], []
    for rel, node in graph["files"].items():
        if is_test(rel):
            continue
        for item in node["strings"]:
            if item["text"].lower() == want:
                places.append("%s:%d" % (rel, item["line"]))
    const = re.compile(r"""\b(?:export\s+)?(?:const|let|static|pub\s+const)\s+([A-Za-z_]\w*)\s*(?::[^=]+)?=\s*['"]%s['"]"""
                       % re.escape(text.strip()), re.IGNORECASE)
    return {"text": text, "places": places, "constants": constants, "_const": const}


def _constants(root, files, text):
    pattern = re.compile(r"""\b(?:export\s+)?(?:pub\s+)?(?:const|let|static)\s+([A-Za-z_]\w*)[^=\n]*=\s*['"]%s['"]"""
                         % re.escape(text))
    out = []
    for rel in sorted(files):
        for m in pattern.finditer(read_text(root, rel) or ""):
            out.append({"name": m.group(1), "path": rel})
    return out


def reuse(root, rel, text, graph):
    """The visible labels in `text` (new content for `rel`) that already exist elsewhere: where, and the named
    constant that holds each when there is one. The agent loop shows these so a label is reused, not copied."""
    rows, seen = [], set()
    for item in _strings(rel, text):
        key = item["text"].lower()
        if key in seen:
            continue
        seen.add(key)
        places = ["%s:%d" % (other, s["line"]) for other, node in graph["files"].items()
                  if other != rel and not is_test(other) for s in node["strings"] if s["text"].lower() == key]
        if not places:
            continue
        files = sorted({p.rsplit(":", 1)[0] for p in places})
        rows.append({"text": item["text"], "files": len(files), "places": places[:3],
                     "constants": _constants(root, files, item["text"])})
    return rows


# ---------------------------------------------------------------- surfaces and features

def surfaces_in(rel, text, config):
    """The screens, routes, menu items and settings keys a file defines."""
    out = []
    if matches_any(rel, config["surfaces"]["screen"]) and not is_test(rel):
        out.append({"kind": "screen", "value": rel, "path": rel, "line": 1})
    if text is None or is_test(rel) or os.path.splitext(rel)[1].lower() not in CODE_EXT:
        return out
    for number, line in enumerate(text.splitlines(), 1):
        out += _line_surfaces(rel, number, line, config)
    return out


def _line_surfaces(rel, number, line, config):
    out = []
    for kind in ("route", "menu", "setting"):
        for entry in config["surfaces"][kind]:
            pattern, files = _pattern(entry)
            if files and not matches_any(rel, files):
                continue
            for m in re.finditer(pattern, line):
                out.append({"kind": kind, "value": m.group(1).strip(), "path": rel, "line": number})
    return out


def _covers(path, rel):
    path = path.rstrip("/")
    return rel == path or rel.startswith(path + "/") or ("*" in path and matches_any(rel, [path]))


def claimed(surface, features):
    kind, value = surface["kind"], surface["value"]
    for feat in features:
        if kind == "screen":
            screens = [s.get("path", "") for s in feat.get("screens", []) if isinstance(s, dict)]
            if any(_covers(p, value) for p in list(feat.get("paths", [])) + screens if p):
                return feat["id"]
        else:
            listed = {"route": "routes", "menu": "menu", "setting": "settings"}[kind]
            if value.lower() in {str(v).lower() for v in feat.get(listed, [])}:
                return feat["id"]
    return None


LISTS = {"route": "routes", "menu": "menu", "setting": "settings"}


def add_hint(surface, features):
    """What to change in features.json for an unmapped surface: the feature that owns its file, and where."""
    kind, value = surface["kind"], surface["value"]
    owner = next((f["id"] for f in features if any(_covers(p, surface["path"]) for p in f.get("paths", [])
                                                   if isinstance(p, str))), None)
    if kind == "screen":
        where = ("add %s to the paths of feature %r" % (value, owner)) if owner else \
            "add it to the paths of the feature it belongs to (or a new feature)"
    elif owner:
        where = 'add "%s" to the "%s" list of feature %r' % (value, LISTS[kind], owner)
    else:
        where = 'add "%s" to the "%s" list of the feature it belongs to (or a new feature)' % (value, LISTS[kind])
    return "the change adds %s %r; %s in .claude/context/features.json (keep the file a JSON list of features)" % (
        kind, value, where)


def load_features(root):
    """(features, findings). Validity problems are errors; a missing file is one finding."""
    findings = []
    path = os.path.join(root, FEATURES)
    if not os.path.exists(path):
        return [], [finding("features", "error", FEATURES, None, "features.json is missing; run install or add "
                            "the repo's features")]
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except ValueError as error:
        return [], [finding("features", "error", FEATURES, None, "features.json is not valid JSON: %s" % error)]
    if not isinstance(data, list):
        return [], [finding("features", "error", FEATURES, None, "features.json must be a list of features")]
    seen, good = set(), []
    for i, feat in enumerate(data):
        where = "feature %d" % (i + 1)
        if not isinstance(feat, dict):
            findings.append(finding("features", "error", FEATURES, None, "%s is not an object" % where))
            continue
        fid = feat.get("id")
        if not isinstance(fid, str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]*", fid or ""):
            findings.append(finding("features", "error", FEATURES, None,
                                    "%s needs an id in lowercase-with-dashes (got %r)" % (where, fid)))
            continue
        if fid in seen:
            findings.append(finding("features", "error", FEATURES, None, "feature id %r is used twice" % fid))
        seen.add(fid)
        if not str(feat.get("summary", "")).strip():
            findings.append(finding("features", "error", FEATURES, None, "feature %r has no summary" % fid))
        paths = feat.get("paths")
        if not isinstance(paths, list) or not paths:
            findings.append(finding("features", "error", FEATURES, None, "feature %r lists no paths" % fid))
            paths = []
        for p in paths:
            if not isinstance(p, str) or not p:
                findings.append(finding("features", "error", FEATURES, None, "feature %r has an empty path" % fid))
            elif "*" not in p and not os.path.exists(os.path.join(root, p)):
                findings.append(finding("features", "error", FEATURES, None,
                                        "feature %r lists %s, which does not exist" % (fid, p)))
        for key in ("terms", "routes", "menu", "settings", "notes"):
            if key in feat and not isinstance(feat[key], list):
                findings.append(finding("features", "error", FEATURES, None, "feature %r: %s must be a list" % (fid, key)))
        for screen in feat.get("screens", []) or []:
            if not isinstance(screen, dict) or not screen.get("name"):
                findings.append(finding("features", "error", FEATURES, None,
                                        "feature %r: each screen needs a name" % fid))
            elif screen.get("path") and not os.path.exists(os.path.join(root, screen["path"])):
                findings.append(finding("features", "error", FEATURES, None,
                                        "feature %r: screen %r points at %s, which does not exist"
                                        % (fid, screen["name"], screen["path"])))
        good.append(feat)
    return good, findings


def check_features(root, config=None, graph_files=None):
    """Valid, and complete: every screen, route, menu item and setting in the repo is claimed by a feature.
    Unclaimed ones are warnings here; the change check makes the ones a change adds errors."""
    config = config or kit_config(root)
    features, findings = load_features(root)
    unclaimed = []
    for rel in graph_files if graph_files is not None else repo_files(root, config):
        for surface in surfaces_in(rel, read_text(root, rel), config):
            if not claimed(surface, features):
                unclaimed.append(surface)
    for s in unclaimed:
        findings.append(finding("features", "warning", s["path"], s["line"],
                                "%s %r is not in any feature in features.json" % (s["kind"], s["value"])))
    return features, findings, unclaimed


def suggest_features(root, unclaimed, features):
    """Draft entries for unclaimed surfaces, one per screen file (named after it) plus one per file of
    other surfaces; the fill task refines them."""
    taken = {f["id"] for f in features}
    drafts = {}
    for s in unclaimed:
        stem = os.path.splitext(os.path.basename(s["path"]))[0]
        stem = re.sub(r"(Page|Screen|View)$", "", stem) or stem
        fid = re.sub(r"[^a-z0-9]+", "-", re.sub(r"([a-z0-9])([A-Z])", r"\1-\2", stem).lower()).strip("-") or "app"
        if fid in taken and fid not in drafts:
            fid = fid + "-" + re.sub(r"[^a-z0-9]+", "-", os.path.dirname(s["path"]).lower()).strip("-")
        draft = drafts.setdefault(fid, {"id": fid, "summary": "TODO: what %s does for the user" % stem,
                                        "paths": [], "terms": [], "notes": ["Drafted by repoctx install; check it."]})
        if s["path"] not in draft["paths"]:
            draft["paths"].append(s["path"])
        if s["kind"] == "screen":
            draft.setdefault("screens", []).append({"name": stem, "path": s["path"]})
        else:
            key = {"route": "routes", "menu": "menu", "setting": "settings"}[s["kind"]]
            if s["value"] not in draft.setdefault(key, []):
                draft[key].append(s["value"])
    return list(drafts.values())


# ---------------------------------------------------------------- the change

def finding(check, severity, path, line, message):
    return {"check": check, "severity": severity, "path": path, "line": line, "message": message}


def changed_files(root, base, head=None):
    """[(status, path)] between base and head, or base and the working tree (with untracked files) by default."""
    args = ["diff", "--name-status", "-M", "-z", base] + ([head] if head else [])
    raw = git(root, *args).split("\0")
    out, i = [], 0
    while i < len(raw) and raw[i]:
        status = raw[i]
        if status.startswith(("R", "C")):
            out.append(("R", raw[i + 2].replace("\\", "/")))
            out.append(("D", raw[i + 1].replace("\\", "/")))
            i += 3
        else:
            out.append((status[0], raw[i + 1].replace("\\", "/")))
            i += 2
    if not head:
        for rel in filter(None, git(root, "ls-files", "-o", "--exclude-standard", "-z").split("\0")):
            out.append(("A", rel.replace("\\", "/")))
    return out


def added_lines(root, base, head, rel, status):
    """[(line number, text)] the change adds to a file."""
    if status == "A" and not head and not git(root, "ls-files", "--", rel).strip():
        text = read_text(root, rel) or ""
        return list(enumerate(text.splitlines(), 1))
    args = ["diff", "-U0", base] + ([head] if head else []) + ["--", rel]
    out, number = [], 0
    for line in git(root, *args, check=False).splitlines():
        m = re.match(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@", line)
        if m:
            number = int(m.group(1))
        elif line.startswith("+") and not line.startswith("+++"):
            out.append((number, line[1:]))
            number += 1
    return out


def ignorable(rel):
    return (rel.startswith(CONTEXT + "/") or os.path.basename(rel) in LOCKFILES or matches_any(rel, GENERATED))


def diff_report(root, base, head=None, config=None, graph=None, features=None):
    config = config or kit_config(root)
    if features is None:
        features, _ = load_features(root)
    changes = changed_files(root, base, head)
    paths = sorted({p for s, p in changes})
    touched = sorted({f["id"] for f in features for p in paths
                      if any(_covers(fp, p) for fp in f.get("paths", []) if isinstance(fp, str))})
    reached = []
    if graph is not None:
        near = set()
        for p in paths:
            near.update(graph["importers"].get(p, []))
        reached = sorted({f["id"] for f in features for p in near
                          if any(_covers(fp, p) for fp in f.get("paths", []) if isinstance(fp, str))} - set(touched))
    added = []
    for status, rel in changes:
        if status == "D" or ignorable(rel) or is_test(rel):
            continue
        if status == "A" and matches_any(rel, config["surfaces"]["screen"]):
            added.append({"kind": "screen", "value": rel, "path": rel, "line": 1})
        if os.path.splitext(rel)[1].lower() not in CODE_EXT:
            continue
        for number, text in added_lines(root, base, head, rel, status):
            added += _line_surfaces(rel, number, text, config)
    return {"base": base, "head": head or "working tree", "files": [{"status": s, "path": p} for s, p in changes],
            "touched": touched, "reached": reached, "added": added}


def record_path(branch):
    return "%s/%s.json" % (CHANGES, branch)


def check_record(root, branch, diff, features):
    findings = []
    meaningful = [f["path"] for f in diff["files"] if not ignorable(f["path"])]
    rel = record_path(branch)
    if not meaningful:
        return None, findings
    try:
        record = read_json(root, rel, None)
    except ValueError as error:
        return None, [finding("record", "error", rel, None, "the change record is not valid JSON: %s" % error)]
    if record is None:
        return None, [finding("record", "error", rel, None,
                              "no change record: write %s with features, changes, spots and kept" % rel)]
    if not isinstance(record, dict):
        return None, [finding("record", "error", rel, None, "the change record must be an object")]
    for key in ("features", "changes", "spots", "kept"):
        if key in record and not isinstance(record[key], list):
            findings.append(finding("record", "error", rel, None, "%s must be a list" % key))
            record[key] = []
    known = {f["id"] for f in features}
    listed = set(record.get("features", []))
    for fid in diff["touched"]:
        if fid not in listed:
            findings.append(finding("record", "error", rel, None,
                                    "the change touches feature %r; list it under features" % fid))
    for fid in sorted(listed - known):
        findings.append(finding("record", "error", rel, None, "feature %r is not in features.json" % fid))
    spots = [s.get("path", "") if isinstance(s, dict) else str(s) for s in record.get("spots", [])]
    for path in meaningful:
        if not any(_covers(s, path) for s in spots if s):
            findings.append(finding("record", "error", path, None,
                                    "changed file %s is not one of the record's spots" % path))
    changed = set(meaningful)
    for s in spots:
        if s and not any(_covers(s, p) for p in changed):
            findings.append(finding("record", "warning", s, None, "spot %s is not part of the change" % s))
    for item in record.get("changes", []):
        if not isinstance(item, dict) or not str(item.get("old", "")).strip():
            findings.append(finding("record", "error", rel, None, "each change needs an old term"))
    return record, findings


def _text_spans(rel, line):
    """The parts of a code line a person reads: string literals and JSX text."""
    if line.strip().startswith(("import ", "use ", "export * from", "from ")):
        return []
    spans = [next(g for g in m.groups() if g is not None) for m in STRING_LIT.finditer(line)]
    spans = [s for s in spans if _visible(s)]
    if os.path.splitext(rel)[1].lower() in UI_EXT:
        spans += JSX_TEXT.findall(line)
    return spans


def check_terms(root, record, config, files):
    findings = []
    if not record:
        return findings
    kept = [k for k in record.get("kept", []) if isinstance(k, dict)]
    allowed = config["allowed"] + [CONTEXT + "/**", "**/CHANGELOG*", "CHANGELOG*"]
    terms = [str(c.get("old", "")).strip() for c in record.get("changes", []) if isinstance(c, dict)]
    terms = [t for t in terms if len(t) >= MIN_TERM]
    if not terms:
        return findings
    patterns = {t: re.compile(r"(?<![A-Za-z0-9_])%s(?![A-Za-z0-9_])" % re.escape(t), re.IGNORECASE) for t in terms}
    for rel in files:
        if matches_any(rel, allowed):
            continue
        text = read_text(root, rel)
        if text is None:
            continue
        ext = os.path.splitext(rel)[1].lower()
        for number, line in enumerate(text.splitlines(), 1):
            spans = [line] if ext in TEXT_EXT else _text_spans(rel, line)
            for term, pattern in patterns.items():
                if any(pattern.search(span) for span in spans):
                    if any(k.get("term", "").lower() == term.lower() and (not k.get("path") or _covers(k["path"], rel))
                           for k in kept):
                        continue
                    findings.append(finding("terms", "error", rel, number,
                                            "old term %r is still here: update it, or keep it with a reason "
                                            "under kept" % term))
    return findings


def read_override(root, branch, head_sha):
    data = read_json(root, os.path.relpath(os.path.join(git_dir(root), OVERRIDE), root), None)
    if isinstance(data, dict) and data.get("branch") == branch and data.get("head") == head_sha:
        return data
    return None


def run_check(root, base=None, branch=None, head=None, record_required=True):
    config = kit_config(root)
    branch = branch or current_branch(root) or "HEAD"
    base = base or default_base(root, head or "HEAD")
    graph = build_graph(root, config)
    files = sorted(graph["files"])
    features, findings, unclaimed = check_features(root, config, files)
    findings = [f for f in findings if f["severity"] == "error"]
    if not base:
        findings.append(finding("diff", "error", None, None, "no main or master branch to compare against; "
                                "pass --base"))
        return result(root, branch, None, findings, features, unclaimed)
    diff = diff_report(root, base, head, config, graph, features)
    for s in diff["added"]:
        if not claimed(s, features):
            findings.append(finding("features", "error", s["path"], s["line"], add_hint(s, features)))
    record = None
    if record_required:
        record, more = check_record(root, branch, diff, features)
        findings += more
    findings += check_terms(root, record, config, files)
    return result(root, branch, diff, findings, features, unclaimed, record)


def result(root, branch, diff, findings, features, unclaimed, record=None):
    errors = [f for f in findings if f["severity"] == "error"]
    head_sha = rev(root, "HEAD")
    override = read_override(root, branch, head_sha) if errors else None
    return {"ok": not errors or override is not None, "branch": branch, "head": head_sha,
            "override": override, "findings": findings, "touched": diff["touched"] if diff else [],
            "reached": diff["reached"] if diff else [], "added": diff["added"] if diff else [],
            "changed": [f["path"] for f in diff["files"]] if diff else [], "features": len(features),
            "unclaimed": len(unclaimed), "record": record_path(branch) if record is not None else None,
            "checker": CHECKER_VERSION}


def findings_text(res):
    lines = []
    if res.get("override"):
        lines.append("Overridden by %s: %s" % (res["override"].get("by", "Nate"), res["override"].get("reason", "")))
    for f in res["findings"]:
        where = f["path"] + (":%d" % f["line"] if f.get("line") else "") if f.get("path") else ""
        lines.append("%s %s%s" % ("ERROR" if f["severity"] == "error" else "warn ", where + ": " if where else "",
                                  f["message"]))
    if res.get("touched"):
        lines.append("Features touched: %s" % ", ".join(res["touched"]))
    lines.append("Change check %s." % ("passed" if res["ok"] else "failed"))
    return "\n".join(lines)


# ---------------------------------------------------------------- hooks

def hook_pre_push(root, stdin):
    status = 0
    for line in stdin.splitlines():
        parts = line.split()
        if len(parts) != 4:
            continue
        local_ref, local_sha, remote_ref, remote_sha = parts
        target = remote_ref.replace("refs/heads/", "")
        if target not in MAINS or local_sha == ZERO_SHA:
            continue
        branch = local_ref.replace("refs/heads/", "") if local_ref.startswith("refs/heads/") else current_branch(root)
        if branch in MAINS:
            features, problems = load_features(root)
            errors = [p for p in problems if p["severity"] == "error"]
            if errors:
                sys.stderr.write(findings_text(result(root, branch, None, errors, features, [])) + "\n")
                status = 1
            continue
        base = remote_sha if remote_sha != ZERO_SHA and rev(root, remote_sha) else default_base(root, local_sha)
        res = run_check(root, base=base, branch=branch, head=local_sha)
        if not res["ok"]:
            sys.stderr.write("repo-context kit: %s can't land on %s yet.\n%s\n" % (branch, target, findings_text(res)))
            status = 1
    return status


def hook_stop(root, stdin):
    """Claude Code's Stop hook: exit 2 (keep working) with findings, 0 to let the session stop, 1 when
    the checker itself failed (shown to the person, never posing as findings about the work)."""
    try:
        return _hook_stop(root, stdin)
    except Exception as error:  # noqa: BLE001 - any crash is reported as a crash, not as findings
        sys.stderr.write("repo-context kit: the change checker itself failed (%s: %s). This is not a finding about "
                         "your work; the session can stop. Run `python3 .githooks/repoctx-check.py check` to see it; "
                         "pre-push still runs the check before anything lands.\n" % (type(error).__name__, error))
        return 1


def _record_open_findings(root, branch, res):
    """Leaves unresolved findings in the branch's change record, where pre-push (which reruns the check)
    and the next session see them."""
    if not branch or branch in MAINS:
        return None
    rel = record_path(branch)
    try:
        record = read_json(root, rel, None)
    except ValueError:
        return None
    record = record if isinstance(record, dict) else {}
    record["open_findings"] = [("%s: %s" % (f["path"], f["message"])) if f.get("path") else f["message"]
                               for f in res["findings"] if f["severity"] == "error"]
    write_text(root, rel, json.dumps(record, indent=1, ensure_ascii=False) + "\n")
    return rel


def _clear_open_findings(root, branch):
    if not branch or branch in MAINS:
        return
    rel = record_path(branch)
    try:
        record = read_json(root, rel, None)
    except ValueError:
        return
    if isinstance(record, dict) and "open_findings" in record:
        del record["open_findings"]
        write_text(root, rel, json.dumps(record, indent=1, ensure_ascii=False) + "\n")


def _hook_stop(root, stdin):
    try:
        event = json.loads(stdin) if stdin.strip() else {}
    except ValueError:
        event = {}
    branch = current_branch(root)
    if branch in MAINS or not branch:
        if not git(root, "status", "--porcelain").strip():
            return 0
        res = run_check(root, base="HEAD", branch=branch or "HEAD", record_required=False)
    else:
        base = default_base(root)
        if not base or (not git(root, "status", "--porcelain").strip() and rev(root, "HEAD") == base):
            return 0
        res = run_check(root, base=base, branch=branch)
    state_path = os.path.join(git_dir(root), STOP_STATE)
    if res["ok"]:
        _clear_open_findings(root, branch)
        try:
            os.remove(state_path)
        except OSError:
            pass
        return 0
    text = findings_text(res)
    digest = hashlib.sha256(text.encode()).hexdigest()[:16]
    try:
        with open(state_path, encoding="utf-8") as f:
            state = json.load(f)
    except (OSError, ValueError):
        state = {}
    repeat = state.get("hash") == digest
    blocks = state.get("blocks", 0) + 1 if event.get("stop_hook_active") else 1
    with open(state_path, "w", encoding="utf-8") as f:
        json.dump({"hash": digest, "blocks": blocks}, f)
    # Never an endless loop: when the session was already sent back by this hook and comes back with the
    # same findings (or keeps coming back), let it stop. The findings stay in the change record, and
    # pre-push reruns the check before anything lands.
    if event.get("stop_hook_active") and (repeat or blocks > STOP_BLOCK_LIMIT):
        where = _record_open_findings(root, branch, res)
        sys.stderr.write("repo-context kit: the same change-check findings are still open; letting the session stop. "
                         "They are saved%s and pre-push still refuses to land them. Tell the person:\n%s\n"
                         % (" in " + where if where else "", text))
        return 0
    sys.stderr.write("repo-context kit: the change check failed. Fix these before you stop (or keep an old term "
                     "with a reason in the change record):\n%s\n" % text)
    return 2


# ---------------------------------------------------------------- install

def _stop_hook_state(settings):
    """"current", "old" (an earlier command for this checker) or None."""
    state = None
    for group in (settings.get("hooks", {}) or {}).get("Stop", []) or []:
        for hook in group.get("hooks", []) or []:
            command = str(hook.get("command", ""))
            if command == STOP_COMMAND:
                return "current"
            if HOOK_SCRIPT in command:
                state = "old"
    return state


def _settings_has_stop(settings):
    return _stop_hook_state(settings) == "current"


def _has_rule(root, name):
    text = read_text(root, name)
    return text is not None and GATE_MARK in text


def checklist(root, config=None):
    """What the repo has and what it misses, as rows {id, label, ok, detail}."""
    config = config or kit_config(root)
    features, problems, unclaimed = check_features(root, config)
    errors = [p for p in problems if p["severity"] == "error"]
    rows = []
    has_features = os.path.exists(os.path.join(root, FEATURES))
    rows.append({"id": "features", "label": "Feature map (.claude/context/features.json)", "ok": has_features and not errors,
                 "detail": ("%d features" % len(features)) if has_features and not errors else
                 (errors[0]["message"] if errors else "missing")})
    rows.append({"id": "complete", "label": "Every screen, route, menu item and setting is in a feature",
                 "ok": not unclaimed, "detail": "%d not mapped yet" % len(unclaimed) if unclaimed else "all mapped"})
    hook = os.path.join(root, HOOKS_DIR, "pre-push")
    copy = os.path.join(root, HOOKS_DIR, HOOK_SCRIPT)
    current = (os.path.exists(copy) and _same_file(copy, os.path.abspath(__file__))
               and (read_text(root, HOOKS_DIR + "/pre-push") or "").replace("\r\n", "\n") == PRE_PUSH)
    lf = HOOK_ATTRIBUTES in (read_text(root, ".gitattributes") or "")
    rows.append({"id": "pre-push", "label": "Pre-push gate (.githooks/pre-push)",
                 "ok": os.path.exists(hook) and current and lf,
                 "detail": "installed" if os.path.exists(hook) and current and lf else
                 ("missing" if not os.path.exists(hook) else "checker copy is out of date" if not current
                  else "line endings not pinned in .gitattributes")})
    hooks_path = git(root, "config", "--get", "core.hooksPath", check=False).strip()
    rows.append({"id": "hooks-path", "label": "git uses .githooks (core.hooksPath)", "ok": hooks_path == HOOKS_DIR,
                 "detail": hooks_path or "not set"})
    settings = read_json(root, ".claude/settings.json", {}) or {}
    rows.append({"id": "stop-hook", "label": "Claude Code Stop hook (.claude/settings.json)",
                 "ok": _settings_has_stop(settings),
                 "detail": {"current": "installed", "old": "an older command (not portable)"}.get(
                     _stop_hook_state(settings), "missing")})
    for name in ("AGENTS.md", "CLAUDE.md"):
        rows.append({"id": "rule-" + name.split(".")[0].lower(), "label": "Gate rule in " + name,
                     "ok": _has_rule(root, name), "detail": "present" if _has_rule(root, name) else "missing"})
    ignore = read_text(root, ".gitignore") or ""
    rows.append({"id": "gitignore", "label": "Graph cache ignored (.gitignore)", "ok": ".claude/context/.cache" in ignore,
                 "detail": "present" if ".claude/context/.cache" in ignore else "missing"})
    return rows, features, unclaimed


def _same_file(a, b):
    try:
        with open(a, "rb") as fa, open(b, "rb") as fb:
            return fa.read().replace(b"\r\n", b"\n") == fb.read().replace(b"\r\n", b"\n")
    except OSError:
        return False


def install(root, dry_run=False, fill_features=False):
    """Set up the gates in a repo. Returns {checklist, actions, conflicts, drafts}; dry-run changes nothing."""
    config = kit_config(root)
    rows, features, unclaimed = checklist(root, config)
    missing = {r["id"] for r in rows if not r["ok"]}
    actions, conflicts = [], []
    drafts = suggest_features(root, unclaimed, features) if unclaimed else []
    if "features" in missing and not os.path.exists(os.path.join(root, FEATURES)):
        actions.append("create %s%s" % (FEATURES, " with %d drafted features" % len(drafts) if fill_features else ""))
    elif fill_features and drafts:
        actions.append("add %d drafted features to %s" % (len(drafts), FEATURES))
    if "pre-push" in missing:
        actions.append("write %s/pre-push and %s/%s" % (HOOKS_DIR, HOOKS_DIR, HOOK_SCRIPT))
    hooks_path = git(root, "config", "--get", "core.hooksPath", check=False).strip()
    if "hooks-path" in missing:
        if hooks_path and hooks_path != HOOKS_DIR:
            conflicts.append("core.hooksPath is %s (another hook manager); add `.githooks/pre-push` to it by hand"
                             % hooks_path)
        else:
            actions.append("git config core.hooksPath %s" % HOOKS_DIR)
    if "stop-hook" in missing:
        actions.append("add the Stop hook to .claude/settings.json")
    for name in ("AGENTS.md", "CLAUDE.md"):
        if "rule-" + name.split(".")[0].lower() in missing:
            actions.append("add the gate rule to %s" % name)
    if "gitignore" in missing:
        actions.append("ignore .claude/context/.cache/ in .gitignore")
    out = {"root": root, "checklist": rows, "actions": actions, "conflicts": conflicts,
           "drafts": drafts, "dryRun": dry_run}
    if dry_run:
        return out
    if not os.path.exists(os.path.join(root, FEATURES)) or (fill_features and drafts):
        merged = features + (drafts if fill_features else [])
        write_text(root, FEATURES, json.dumps(merged, indent=1, ensure_ascii=False, sort_keys=True) + "\n")
    if "pre-push" in missing:
        attributes = read_text(root, ".gitattributes") or ""
        if HOOK_ATTRIBUTES not in attributes:
            write_text(root, ".gitattributes", (attributes.rstrip("\n") + "\n" if attributes.strip() else "") + HOOK_ATTRIBUTES + "\n")
        write_text(root, HOOKS_DIR + "/pre-push", PRE_PUSH)
        shutil.copyfile(os.path.abspath(__file__), os.path.join(root, HOOKS_DIR, HOOK_SCRIPT))
        try:
            os.chmod(os.path.join(root, HOOKS_DIR, "pre-push"), 0o755)
        except OSError:
            pass
    if "hooks-path" in missing and not (hooks_path and hooks_path != HOOKS_DIR):
        git(root, "config", "core.hooksPath", HOOKS_DIR)
    if "stop-hook" in missing:
        settings = read_json(root, ".claude/settings.json", {}) or {}
        stop = settings.setdefault("hooks", {}).setdefault("Stop", [])
        # Replace an older command for this checker instead of running it twice.
        for group in stop:
            group["hooks"] = [h for h in group.get("hooks", []) or [] if HOOK_SCRIPT not in str(h.get("command", ""))]
        stop[:] = [group for group in stop if group.get("hooks")]
        stop.append({"hooks": [{"type": "command", "command": STOP_COMMAND}]})
        write_text(root, ".claude/settings.json", json.dumps(settings, indent=2) + "\n")
    rule = GATE_RULE.format(mark=GATE_MARK, end=GATE_END)
    for name in ("AGENTS.md", "CLAUDE.md"):
        if "rule-" + name.split(".")[0].lower() in missing:
            text = read_text(root, name) or ""
            write_text(root, name, (text.rstrip("\n") + "\n\n" if text.strip() else "") + rule)
    if "gitignore" in missing:
        text = read_text(root, ".gitignore") or ""
        write_text(root, ".gitignore", (text.rstrip("\n") + "\n" if text.strip() else "") + ".claude/context/.cache/\n")
    out["checklist"] = checklist(root, config)[0]
    return out


# ---------------------------------------------------------------- command line

def _print(data, as_json, text):
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    print(json.dumps(data, indent=1, ensure_ascii=False) if as_json else text)


def main(argv=None):
    ap = argparse.ArgumentParser(prog="repoctx-check", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--repo")
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("check")
    c.add_argument("--base")
    c.add_argument("--branch")
    c.add_argument("--head")
    c.add_argument("--no-record", action="store_true")
    c.add_argument("--json", action="store_true")
    for name in ("features", "strings"):
        sub.add_parser(name).add_argument("--json", action="store_true")
    g = sub.add_parser("graph")
    g.add_argument("--json", action="store_true")
    g.add_argument("--summary", action="store_true", help="counts and the shared-strings report only")
    g.add_argument("--idents", action="store_true", help="also every identifier per file")
    d = sub.add_parser("diff")
    d.add_argument("--base")
    d.add_argument("--head")
    d.add_argument("--json", action="store_true")
    lab = sub.add_parser("label")
    lab.add_argument("text")
    lab.add_argument("--json", action="store_true")
    ru = sub.add_parser("reuse")
    ru.add_argument("path")
    ru.add_argument("--json", action="store_true")
    i = sub.add_parser("install")
    i.add_argument("--dry-run", action="store_true")
    i.add_argument("--fill-features", action="store_true")
    i.add_argument("--json", action="store_true")
    h = sub.add_parser("hook")
    h.add_argument("which", choices=["pre-push", "stop"])
    h.add_argument("rest", nargs="*")
    a = ap.parse_args(argv)
    try:
        root = repo_root(a.repo)
        if a.cmd == "hook":
            stdin = sys.stdin.read() if not sys.stdin.isatty() else ""
            return hook_pre_push(root, stdin) if a.which == "pre-push" else hook_stop(root, stdin)
        if a.cmd == "check":
            res = run_check(root, a.base, a.branch, a.head, record_required=not a.no_record)
            _print(res, a.json, findings_text(res))
            return 0 if res["ok"] else 1
        if a.cmd == "features":
            features, findings, unclaimed = check_features(root)
            ok = not [f for f in findings if f["severity"] == "error"]
            _print({"ok": ok, "features": len(features), "findings": findings, "unclaimed": unclaimed}, a.json,
                   "\n".join(f["message"] for f in findings) or "features.json is valid and complete")
            return 0 if ok else 1
        if a.cmd == "diff":
            config = kit_config(root)
            base = a.base or default_base(root, a.head or "HEAD")
            if not base:
                raise RepoError("no main or master branch to compare against; pass --base")
            rep = diff_report(root, base, a.head, config, build_graph(root, config))
            _print(rep, a.json, "Touched: %s\nReached through imports: %s\nAdded: %s" % (
                ", ".join(rep["touched"]) or "none", ", ".join(rep["reached"]) or "none",
                ", ".join("%s %s" % (s["kind"], s["value"]) for s in rep["added"]) or "nothing"))
            return 0
        if a.cmd == "graph":
            graph = build_graph(root)
            if a.summary:
                out = dict(graph_summary(graph), sharedStrings=shared_strings(graph))
                _print(out, a.json, json.dumps(out, indent=1))
                return 0
            if not a.idents:
                for node in graph["files"].values():
                    node.pop("idents", None)
            _print(graph, a.json, json.dumps(graph_summary(graph)))
            return 0
        if a.cmd == "strings":
            rows = shared_strings(build_graph(root))
            _print(rows, a.json, "\n".join("%d files: %s" % (r["files"], r["text"]) for r in rows) or "none")
            return 0
        if a.cmd == "label":
            graph = build_graph(root)
            found = find_label(graph, a.text)
            pattern = found.pop("_const")
            for rel in graph["files"]:
                text = read_text(root, rel) or ""
                for m in pattern.finditer(text):
                    found["constants"].append({"name": m.group(1), "path": rel})
            _print(found, a.json, json.dumps(found, indent=1))
            return 0
        if a.cmd == "reuse":
            text = sys.stdin.read() if not sys.stdin.isatty() else ""
            rows = reuse(root, a.path.replace("\\", "/"), text, build_graph(root))
            _print(rows, a.json, "\n".join("%s: %d files%s" % (r["text"], r["files"], "".join(
                ", const %s in %s" % (c["name"], c["path"]) for c in r["constants"])) for r in rows) or "none")
            return 0
        if a.cmd == "install":
            out = install(root, a.dry_run, a.fill_features)
            text = "\n".join(["%s %s: %s" % ("ok     " if r["ok"] else "MISSING", r["label"], r["detail"])
                              for r in out["checklist"]] + ["", "Actions%s:" % (" (dry run)" if a.dry_run else "")]
                             + ["  " + x for x in out["actions"] or ["nothing to do"]]
                             + ["Conflicts:"] * bool(out["conflicts"]) + ["  " + x for x in out["conflicts"]])
            _print(out, a.json, text)
            return 0
    except RepoError as error:
        sys.stderr.write("repoctx-check: %s\n" % error)
        # For the Stop hook, 2 would mean "findings, keep working": a setup problem is not one.
        return 1 if a.cmd == "hook" and a.which == "stop" else 2
    return 2


if __name__ == "__main__":
    sys.exit(main())
